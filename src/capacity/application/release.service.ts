import { Injectable } from '@nestjs/common';
import { scaleRate } from '../../shared/money';
import { StreamLagRegistry } from '../../shared/stream-lag';
import { CapacityRefusal } from '../domain/errors';
import { PendingLedgerEntry } from '../domain/ledger-entry';
import { advancePosition } from '../domain/position';
import {
  ReservationSnapshot,
  releasePolicy,
} from '../domain/policies/release.policy';
import { InvoiceReservationEntity } from '../infrastructure/entities/invoice-reservation.entity';
import { ProgramEntity } from '../infrastructure/entities/program.entity';
import { ProgramRepository } from '../infrastructure/repositories/program.repository';
import { UnitOfWork } from '../infrastructure/unit-of-work';
import {
  AvailabilityBody,
  toAvailabilityBody,
} from './availability.projection';
import {
  IdempotencyService,
  RequestIdentity,
  reserveFingerprint,
} from './idempotency.service';
import { ReservationBody, toReservationBody } from './reservation.projection';

export interface ReleaseCommand {
  readonly organisationId: string;
  readonly programId: string;
  readonly requestId: string;
  readonly invoiceId: string;
  readonly releaseMinor: bigint;
  readonly currency: string;
  readonly actor: string;
  readonly correlationId: string;
}

export interface ReleaseBody {
  readonly reservation: ReservationBody;
  readonly availability: AvailabilityBody;
}

export interface ReleaseOutcome {
  readonly created: boolean;
  readonly body: ReleaseBody;
}

interface InvoiceReservationRow {
  program_id: string;
  invoice_id: string;
  invoice_amount_minor: string;
  invoice_currency: string;
  program_currency: string;
  reserved_minor: string;
  outstanding_invoice_minor: string;
  outstanding_reserved_minor: string;
  fx_rate: string | null;
  fx_rate_effective_at: Date | null;
  fx_rate_source: string | null;
  status: InvoiceReservationEntity['status'];
  created_at: Date;
}

function toInvoiceReservationEntity(
  row: InvoiceReservationRow,
): InvoiceReservationEntity {
  const entity = new InvoiceReservationEntity();
  entity.programId = row.program_id;
  entity.invoiceId = row.invoice_id;
  entity.invoiceAmountMinor = BigInt(row.invoice_amount_minor);
  entity.invoiceCurrency = row.invoice_currency;
  entity.programCurrency = row.program_currency;
  entity.reservedMinor = BigInt(row.reserved_minor);
  entity.outstandingInvoiceMinor = BigInt(row.outstanding_invoice_minor);
  entity.outstandingReservedMinor = BigInt(row.outstanding_reserved_minor);
  entity.fxRate = row.fx_rate;
  entity.fxRateEffectiveAt = row.fx_rate_effective_at;
  entity.fxRateSource = row.fx_rate_source;
  entity.status = row.status;
  entity.createdAt = row.created_at;
  return entity;
}

@Injectable()
export class ReleaseService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly programRepository: ProgramRepository,
    private readonly idempotency: IdempotencyService,
    private readonly streamLag: StreamLagRegistry,
  ) {}

  async release(command: ReleaseCommand): Promise<ReleaseOutcome> {
    return this.unitOfWork.withProgramLock(
      command.programId,
      async ({ manager, program }): Promise<ReleaseOutcome> => {
        const now = new Date();

        const identity: RequestIdentity = {
          organisationId: command.organisationId,
          requestId: command.requestId,
          operation: 'RELEASE',
          fingerprint: reserveFingerprint({
            programId: command.programId,
            invoiceId: command.invoiceId,
            amountMinor: command.releaseMinor.toString(),
            currency: command.currency,
          }),
        };

        const idempotencyDecision = await this.idempotency.begin(
          manager,
          identity,
          now,
        );
        if (idempotencyDecision.kind === 'refused') {
          throw new CapacityRefusal(idempotencyDecision.code);
        }
        if (idempotencyDecision.kind === 'replay') {
          return {
            created: false,
            body: idempotencyDecision.outcome as unknown as ReleaseBody,
          };
        }

        // FR-019e: while the program's position cannot be verified, every write
        // is refused — a release draws on the same cached position a reservation
        // does, so it cannot be vouched for either.
        if (program.positionVerified === false) {
          throw new CapacityRefusal('POSITION_UNVERIFIED');
        }

        const rows = await manager.query<InvoiceReservationRow[]>(
          `SELECT *
             FROM invoice_reservation
            WHERE program_id = $1 AND invoice_id = $2
            FOR UPDATE`,
          [command.programId, command.invoiceId],
        );
        const row = rows[0];
        if (row === undefined) {
          throw new CapacityRefusal('NOT_FOUND');
        }

        // FR-009: the rate recorded on the reservation is reused, never
        // re-quoted, so FX drift cannot strand minor units.
        const reservation: ReservationSnapshot = {
          invoiceCurrency: row.invoice_currency,
          programCurrency: row.program_currency,
          outstandingInvoiceMinor: BigInt(row.outstanding_invoice_minor),
          outstandingReservedMinor: BigInt(row.outstanding_reserved_minor),
          status: row.status,
        };

        const decision = releasePolicy({
          releaseMinor: command.releaseMinor,
          releaseCurrency: command.currency,
          reservation,
          scaledRate: scaleRate(row.fx_rate ?? '1.0'),
        });

        if (!decision.ok) {
          throw new CapacityRefusal(decision.error);
        }

        const applied = decision.value;
        const ledgerEntry: PendingLedgerEntry = {
          deltaMinor: -applied.deltaMinor,
          component: 'LOCAL',
          cause: 'RELEASE',
          originReference: command.invoiceId,
          actor: command.actor,
          correlationId: command.correlationId,
        };

        const result = advancePosition(
          this.programRepository.toPosition(program),
          [ledgerEntry],
          now,
        );

        await this.programRepository.persistAdvance(
          manager,
          command.programId,
          result,
          now,
        );

        await manager.query(
          `UPDATE invoice_reservation
              SET outstanding_invoice_minor = $3,
                  outstanding_reserved_minor = $4,
                  status = $5,
                  updated_at = $6
            WHERE program_id = $1 AND invoice_id = $2`,
          [
            command.programId,
            command.invoiceId,
            applied.outstandingInvoiceMinor.toString(),
            applied.outstandingReservedMinor.toString(),
            applied.status,
            now,
          ],
        );
        const updatedRow: InvoiceReservationRow = {
          ...row,
          outstanding_invoice_minor:
            applied.outstandingInvoiceMinor.toString(),
          outstanding_reserved_minor:
            applied.outstandingReservedMinor.toString(),
          status: applied.status,
        };
        // `advancePosition` carries the position fields only; mirror the
        // `position_changed_at` that `persistAdvance` just wrote so the
        // response agrees with the row.
        const programAfter: ProgramEntity = {
          ...program,
          ...result.program,
          positionChangedAt: now,
        };
        const body: ReleaseBody = {
          reservation: toReservationBody(
            toInvoiceReservationEntity(updatedRow),
          ),
          availability: toAvailabilityBody(
            programAfter,
            false,
            this.streamLag.newestObservedFor(programAfter.id),
          ),
        };

        await this.idempotency.complete(
          manager,
          identity,
          body as unknown as Record<string, unknown>,
        );

        return { created: true, body };
      },
    );
  }
}
