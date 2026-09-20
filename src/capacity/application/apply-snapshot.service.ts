import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { ReconciliationSnapshot } from '../../shared/treasury/reconciliation-snapshot';
import { StreamCoordinates } from '../../shared/treasury/capacity-event';
import { PendingLedgerEntry, PositionComponent } from '../domain/ledger-entry';
import {
  SnapshotDeltas,
  SnapshotReservation,
  applySnapshotPolicy,
} from '../domain/policies/apply-snapshot.policy';
import { advancePosition } from '../domain/position';
import { ProgramRepository } from '../infrastructure/repositories/program.repository';
import { ProgramStreamPositionRepository } from '../infrastructure/repositories/program-stream-position.repository';
import { ProgramNotFoundError, UnitOfWork } from '../infrastructure/unit-of-work';

export type SnapshotQuarantineReason =
  | 'UNKNOWN_PROGRAM'
  | 'CURRENCY_MISMATCH'
  | 'VERSION_CONFLICT'
  | 'MISSING_ACK_MARKER'
  | 'IMPLAUSIBLE_DELTA'
  | 'SNAPSHOT_INCONSISTENT';

export type SnapshotInspectOutcome =
  | { readonly kind: 'proceed' }
  | { readonly kind: 'ignored' }
  | { readonly kind: 'quarantined'; readonly reason: SnapshotQuarantineReason };

export type SnapshotApplyOutcome =
  | { readonly kind: 'applied' }
  | { readonly kind: 'ignored' }
  | { readonly kind: 'quarantined'; readonly reason: SnapshotQuarantineReason };

interface ProcessedMessageRow {
  message_id: string;
  content_hash: string;
}

interface ContentHashRow {
  content_hash: string;
}

interface ReservationRow {
  id: string;
  origin: 'LOCAL' | 'TREASURY';
  outstanding_reserved_minor: string;
  treasury_acknowledged: boolean;
  acknowledged_by_version: string | null;
  treasury_reference: string | null;
  confirmed_at: Date;
}

const DEFAULT_DELTA_GUARD_RATIO = 0.5;

/** Stable SHA-256 over the fields that determine a snapshot's effect (FR-013b). */
export function reconciliationSnapshotContentHash(
  snapshot: ReconciliationSnapshot,
): string {
  const acknowledgement = snapshot.acknowledgement;
  return createHash('sha256')
    .update(
      JSON.stringify({
        currency: snapshot.currency,
        creditLimitMinor: snapshot.creditLimitMinor.toString(),
        reservedMinor: snapshot.reservedMinor.toString(),
        effectiveAt: snapshot.effectiveAt.toISOString(),
        acknowledgement:
          acknowledgement === null
            ? null
            : {
                kind: acknowledgement.kind,
                reservationReferences: acknowledgement.reservationReferences,
                ingestedThrough:
                  acknowledgement.ingestedThrough?.toISOString() ?? null,
              },
      }),
    )
    .digest('hex');
}

@Injectable()
export class ApplySnapshotService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly unitOfWork: UnitOfWork,
    private readonly programRepository: ProgramRepository,
    private readonly streamPositions: ProgramStreamPositionRepository,
    private readonly config: ConfigService,
  ) {}

  async inspect(
    snapshot: ReconciliationSnapshot,
  ): Promise<SnapshotInspectOutcome> {
    // FR-013a: identity wins, before the staleness rule is even considered.
    const byId = await this.dataSource.query<{ message_id: string }[]>(
      `SELECT message_id FROM processed_message WHERE message_id = $1`,
      [snapshot.messageId],
    );
    if (byId.length > 0) return { kind: 'ignored' };

    const program = await this.programRepository.findById(
      this.dataSource,
      snapshot.programId,
    );
    if (program === null) return { kind: 'quarantined', reason: 'UNKNOWN_PROGRAM' };
    if (program.currency !== snapshot.currency) {
      return { kind: 'quarantined', reason: 'CURRENCY_MISMATCH' };
    }

    // FR-012: a snapshot older than the applied version asserts superseded
    // state and carries no information.
    if (snapshot.version < program.treasuryVersion) {
      return { kind: 'ignored' };
    }

    // FR-013b: same (program, kind, version), different content -> conflict.
    if (snapshot.version === program.treasuryVersion) {
      const sameVersion = await this.dataSource.query<ContentHashRow[]>(
        `SELECT content_hash FROM processed_message
          WHERE program_id = $1 AND kind = 'SNAPSHOT' AND version = $2`,
        [snapshot.programId, snapshot.version.toString()],
      );
      const existing = sameVersion[0];
      if (existing !== undefined) {
        return existing.content_hash === reconciliationSnapshotContentHash(snapshot)
          ? { kind: 'ignored' }
          : { kind: 'quarantined', reason: 'VERSION_CONFLICT' };
      }
    }

    return { kind: 'proceed' };
  }

  async apply(
    snapshot: ReconciliationSnapshot,
    coordinates: StreamCoordinates,
  ): Promise<SnapshotApplyOutcome> {
    const marker = snapshot.acknowledgement;
    if (marker === null) {
      return { kind: 'quarantined', reason: 'MISSING_ACK_MARKER' };
    }

    try {
      return await this.unitOfWork.withProgramLock(
        snapshot.programId,
        async ({ manager, program }): Promise<SnapshotApplyOutcome> => {
          if (program.currency !== snapshot.currency) {
            return { kind: 'quarantined', reason: 'CURRENCY_MISMATCH' } as const;
          }

          // Identity, version and staleness are re-checked under the program
          // lock: `inspect` is a read that can race a concurrent apply.
          const byId = await manager.query<ProcessedMessageRow[]>(
            `SELECT message_id, content_hash FROM processed_message WHERE message_id = $1`,
            [snapshot.messageId],
          );
          if (byId.length > 0) return { kind: 'ignored' } as const;

          const contentHash = reconciliationSnapshotContentHash(snapshot);
          const sameVersion = await manager.query<ProcessedMessageRow[]>(
            `SELECT message_id, content_hash FROM processed_message
              WHERE program_id = $1 AND kind = 'SNAPSHOT' AND version = $2`,
            [snapshot.programId, snapshot.version.toString()],
          );
          const existing = sameVersion[0];
          if (existing !== undefined) {
            if (existing.message_id === snapshot.messageId) {
              return { kind: 'ignored' } as const;
            }
            return existing.content_hash === contentHash
              ? ({ kind: 'ignored' } as const)
              : ({ kind: 'quarantined', reason: 'VERSION_CONFLICT' } as const);
          }

          if (snapshot.version < program.treasuryVersion) {
            return { kind: 'ignored' } as const;
          }

          const reservations = await this.loadReservations(
            manager,
            snapshot.programId,
          );

          // Marker first, then sums (FR-011d). The policy is pure; nothing is
          // written until the snapshot has been accepted.
          const decision = applySnapshotPolicy({
            program: this.programRepository.toPosition(program),
            version: snapshot.version,
            reservedMinor: snapshot.reservedMinor,
            creditLimitMinor: snapshot.creditLimitMinor,
            marker: {
              kind: marker.kind,
              reservationReferences: marker.reservationReferences,
              ingestedThrough: marker.ingestedThrough,
            },
            reservations,
          });

          if (decision.kind === 'refuse') {
            return { kind: 'quarantined', reason: decision.reason } as const;
          }

          // FR-032: the guard is scoped to |delta_treasury|. delta_local raises
          // investigation_required and delta_limit is treasury's own assertion,
          // so neither is a "treasury correction" the guard governs.
          if (
            this.exceedsMagnitudeGuard(
              decision.deltas.treasury,
              program.creditLimitMinor,
            )
          ) {
            return { kind: 'quarantined', reason: 'IMPLAUSIBLE_DELTA' } as const;
          }

          const now = new Date();

          // Offset commit follows the DB commit (Key Decision 1): the
          // processed_message row is written in the SAME transaction as the
          // ledger entries, so a crash between the two replays and dedupes.
          await manager.query(
            `INSERT INTO processed_message
               (message_id, program_id, kind, version, content_hash, processed_at)
             VALUES ($1, $2, 'SNAPSHOT', $3, $4, $5)`,
            [
              snapshot.messageId,
              snapshot.programId,
              snapshot.version.toString(),
              contentHash,
              now,
            ],
          );

          const entries = this.buildEntries(decision.deltas, snapshot);

          // A reconciliation correction may raise the LOCAL component while the
          // program is, or becomes, over-limit (FR-011c/FR-011g). The backstop
          // trigger would abort that legitimate write, so stand it down for the
          // remainder of this transaction only. The reservation path never sets
          // this, so its guard is unchanged.
          await manager.query(
            `SELECT set_config('capacity.reconciliation_in_progress', 'on', true)`,
          );

          const result = advancePosition(
            this.programRepository.toPosition(program),
            entries,
            now,
          );
          await this.programRepository.persistAdvance(
            manager,
            snapshot.programId,
            result,
            now,
          );

          // FR-012: the applied-version marker advances even when the snapshot
          // corrected nothing. Progress and effect are separate facts.
          // FR-019d: a fresh snapshot re-establishes the position, so it clears
          // the recovery flag set by FR-019e. Stale/ignored/quarantined
          // snapshots return before this write and never clear it.
          await manager.query(
            `UPDATE program
                SET treasury_version = $2,
                    treasury_effective_at = $3,
                    investigation_required = investigation_required OR $4,
                    position_verified = TRUE
              WHERE id = $1`,
            [
              snapshot.programId,
              snapshot.version.toString(),
              snapshot.effectiveAt,
              decision.investigationRequired,
            ],
          );

          // FR-011e: the marker is durable, so the decision is reproducible.
          await manager.query(
            `INSERT INTO snapshot_acknowledgement
               (message_id, program_id, version, kind, reservation_references, ingested_through)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              snapshot.messageId,
              snapshot.programId,
              snapshot.version.toString(),
              marker.kind,
              marker.reservationReferences,
              marker.ingestedThrough,
            ],
          );

          if (decision.acknowledgedReservationIds.length > 0) {
            await manager.query(
              `UPDATE invoice_reservation
                  SET treasury_acknowledged = TRUE,
                      acknowledged_by_version = $3,
                      updated_at = $4
                WHERE program_id = $1 AND id = ANY($2::uuid[])`,
              [
                snapshot.programId,
                decision.acknowledgedReservationIds,
                snapshot.version.toString(),
                now,
              ],
            );
          }

          await this.streamPositions.upsert(
            manager,
            snapshot.programId,
            coordinates,
            now,
          );

          return { kind: 'applied' } as const;
        },
      );
    } catch (error) {
      if (error instanceof ProgramNotFoundError) {
        return { kind: 'quarantined', reason: 'UNKNOWN_PROGRAM' };
      }
      throw error;
    }
  }

  private async loadReservations(
    manager: EntityManager,
    programId: string,
  ): Promise<SnapshotReservation[]> {
    const rows = await manager.query<ReservationRow[]>(
      `SELECT id, origin, outstanding_reserved_minor, treasury_acknowledged,
              acknowledged_by_version, treasury_reference, confirmed_at
         FROM invoice_reservation
        WHERE program_id = $1`,
      [programId],
    );
    return rows.map((row) => ({
      id: row.id,
      origin: row.origin,
      outstandingReservedMinor: BigInt(row.outstanding_reserved_minor),
      treasuryAcknowledged: row.treasury_acknowledged,
      acknowledgedByVersion:
        row.acknowledged_by_version === null
          ? null
          : BigInt(row.acknowledged_by_version),
      treasuryReference: row.treasury_reference,
      confirmedAt: row.confirmed_at,
    }));
  }

  private buildEntries(
    deltas: SnapshotDeltas,
    snapshot: ReconciliationSnapshot,
  ): PendingLedgerEntry[] {
    const actor = 'treasury';
    const correlationId = snapshot.correlationId ?? snapshot.messageId;
    const entries: PendingLedgerEntry[] = [];
    const push = (component: PositionComponent, deltaMinor: bigint): void => {
      // One entry per non-zero component delta; none for a zero delta (FR-011f).
      if (deltaMinor === 0n) return;
      entries.push({
        deltaMinor,
        component,
        cause: 'RECONCILIATION_ADJUSTMENT',
        originReference: snapshot.messageId,
        actor,
        correlationId,
      });
    };
    push('TREASURY', deltas.treasury);
    push('LOCAL', deltas.local);
    push('LIMIT', deltas.limit);
    return entries;
  }

  private exceedsMagnitudeGuard(
    deltaTreasury: bigint,
    creditLimitMinor: bigint,
  ): boolean {
    const ratio =
      this.config.get<number>('SNAPSHOT_DELTA_GUARD_RATIO') ??
      DEFAULT_DELTA_GUARD_RATIO;
    const threshold = BigInt(Math.floor(ratio * Number(creditLimitMinor)));
    const magnitude = deltaTreasury < 0n ? -deltaTreasury : deltaTreasury;
    return magnitude > threshold;
  }
}
