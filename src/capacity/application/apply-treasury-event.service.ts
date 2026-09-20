import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  CapacityEvent,
  StreamCoordinates,
} from '../../shared/treasury/capacity-event';
import { PendingLedgerEntry } from '../domain/ledger-entry';
import { advancePosition } from '../domain/position';
import { ProgramEntity } from '../infrastructure/entities/program.entity';
import { ProgramRepository } from '../infrastructure/repositories/program.repository';
import { ProgramStreamPositionRepository } from '../infrastructure/repositories/program-stream-position.repository';
import { ProgramNotFoundError, UnitOfWork } from '../infrastructure/unit-of-work';

export type ApplyQuarantineReason =
  | 'UNKNOWN_PROGRAM'
  | 'CURRENCY_MISMATCH'
  | 'VERSION_CONFLICT';

export type InspectOutcome =
  | { readonly kind: 'proceed' }
  | { readonly kind: 'already_applied' }
  | { readonly kind: 'quarantined'; readonly reason: ApplyQuarantineReason };

export type ApplyOutcome =
  | { readonly kind: 'applied' }
  | { readonly kind: 'already_applied' }
  | { readonly kind: 'echo_suppressed' }
  | { readonly kind: 'quarantined'; readonly reason: ApplyQuarantineReason };

/** Stable SHA-256 over the fields that determine an event's effect (FR-013b). */
export function capacityEventContentHash(event: CapacityEvent): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        type: event.type,
        amountMinor: event.payload.amountMinor.toString(),
        currency: event.payload.currency,
        reservationReference: event.payload.reservationReference,
      }),
    )
    .digest('hex');
}

@Injectable()
export class ApplyTreasuryEventService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly unitOfWork: UnitOfWork,
    private readonly programRepository: ProgramRepository,
    private readonly streamPositions: ProgramStreamPositionRepository,
  ) {}

  async inspect(event: CapacityEvent): Promise<InspectOutcome> {
    // FR-013a: identity wins.
    const byId = await this.dataSource.query<{ message_id: string }[]>(
      `SELECT message_id FROM processed_message WHERE message_id = $1`,
      [event.messageId],
    );
    if (byId.length > 0) return { kind: 'already_applied' };

    const program = await this.programRepository.findById(
      this.dataSource,
      event.programId,
    );
    if (program === null) return { kind: 'quarantined', reason: 'UNKNOWN_PROGRAM' };
    if (program.currency !== event.payload.currency) {
      return { kind: 'quarantined', reason: 'CURRENCY_MISMATCH' };
    }

    // FR-013b: same (program, kind, version), different content -> VERSION_CONFLICT.
    const sameVersion = await this.dataSource.query<{ content_hash: string }[]>(
      `SELECT content_hash FROM processed_message
        WHERE program_id = $1 AND kind = 'EVENT' AND version = $2`,
      [event.programId, event.version.toString()],
    );
    const existing = sameVersion[0];
    if (existing !== undefined) {
      return existing.content_hash === capacityEventContentHash(event)
        ? { kind: 'already_applied' }
        : { kind: 'quarantined', reason: 'VERSION_CONFLICT' };
    }

    return { kind: 'proceed' };
  }

  async apply(
    event: CapacityEvent,
    coordinates: StreamCoordinates,
  ): Promise<ApplyOutcome> {
    try {
      return await this.unitOfWork.withProgramLock(event.programId, async ({ manager, program }) => {
        if (program.currency !== event.payload.currency) {
          return { kind: 'quarantined', reason: 'CURRENCY_MISMATCH' } as const;
        }

        const now = new Date();
        const contentHash = capacityEventContentHash(event);

        // FR-013b re-checked under the program lock. `inspect` is a read that
        // can race a concurrent apply for the same program, and the database
        // enforces only message identity, so a same-version/different-content
        // pair could otherwise both apply. Serialising on the program row closes
        // that window.
        const sameVersion = await manager.query<
          { message_id: string; content_hash: string }[]
        >(
          `SELECT message_id, content_hash FROM processed_message
            WHERE program_id = $1 AND kind = 'EVENT' AND version = $2`,
          [event.programId, event.version.toString()],
        );
        const existing = sameVersion[0];
        if (existing !== undefined) {
          if (existing.message_id === event.messageId) {
            return { kind: 'already_applied' } as const;
          }
          return existing.content_hash === contentHash
            ? ({ kind: 'already_applied' } as const)
            : ({ kind: 'quarantined', reason: 'VERSION_CONFLICT' } as const);
        }

        // Offset commit follows the DB commit (Key Decision 1): the
        // processed_message row is written in the SAME transaction as the ledger
        // entry, so a crash between the two replays and dedupes.
        const inserted = await manager.query<{ message_id: string }[]>(
          `INSERT INTO processed_message
             (message_id, program_id, kind, version, content_hash, processed_at)
           VALUES ($1, $2, 'EVENT', $3, $4, $5)
           ON CONFLICT (message_id) DO NOTHING
           RETURNING message_id`,
          [
            event.messageId,
            event.programId,
            event.version.toString(),
            contentHash,
            now,
          ],
        );
        if (inserted.length === 0) return { kind: 'already_applied' } as const;

        // FR-010a echo suppression: only the reservation event types carry a
        // reservationReference and only they can be an echo of a booking this
        // service originated. Applying this to LIMIT_CHANGED would silently drop
        // a legitimate limit assertion that happened to carry the field.
        const isReservationEvent =
          event.type === 'RESERVATION_BOOKED' ||
          event.type === 'RESERVATION_RELEASED';
        if (isReservationEvent && event.payload.reservationReference !== null) {
          const echo = await manager.query<{ id: string }[]>(
            `SELECT id FROM invoice_reservation
              WHERE program_id = $1 AND treasury_reference = $2`,
            [event.programId, event.payload.reservationReference],
          );
          if (echo.length > 0) {
            await manager.query(
              `UPDATE invoice_reservation
                  SET treasury_acknowledged = TRUE,
                      acknowledged_by_version = $3,
                      updated_at = $4
                WHERE program_id = $1 AND treasury_reference = $2
                  AND treasury_acknowledged = FALSE`,
              [
                event.programId,
                event.payload.reservationReference,
                event.version.toString(),
                now,
              ],
            );
            await this.streamPositions.upsert(
              manager,
              event.programId,
              coordinates,
              now,
            );
            return { kind: 'echo_suppressed' } as const;
          }
        }

        const entry = this.buildEntry(event, program);
        const result = advancePosition(
          this.programRepository.toPosition(program),
          [entry],
          now,
        );
        await this.programRepository.persistAdvance(
          manager,
          event.programId,
          result,
          now,
        );
        await this.streamPositions.upsert(manager, event.programId, coordinates, now);
        return { kind: 'applied' } as const;
      });
    } catch (error) {
      if (error instanceof ProgramNotFoundError) {
        return { kind: 'quarantined', reason: 'UNKNOWN_PROGRAM' };
      }
      throw error;
    }
  }

  private buildEntry(
    event: CapacityEvent,
    program: ProgramEntity,
  ): PendingLedgerEntry {
    const actor = 'treasury';
    const correlationId = event.correlationId ?? event.messageId;

    switch (event.type) {
      case 'RESERVATION_BOOKED':
        return {
          deltaMinor: event.payload.amountMinor,
          component: 'TREASURY',
          cause: 'TREASURY_EVENT',
          originReference:
            event.payload.reservationReference ?? event.messageId,
          actor,
          correlationId,
        };
      case 'RESERVATION_RELEASED':
        return {
          deltaMinor: -event.payload.amountMinor,
          component: 'TREASURY',
          cause: 'TREASURY_EVENT',
          originReference:
            event.payload.reservationReference ?? event.messageId,
          actor,
          correlationId,
        };
      case 'LIMIT_CHANGED':
        return {
          deltaMinor: event.payload.amountMinor - program.creditLimitMinor,
          component: 'LIMIT',
          cause: 'LIMIT_CHANGE',
          originReference: event.messageId,
          actor,
          correlationId,
        };
    }
  }
}
