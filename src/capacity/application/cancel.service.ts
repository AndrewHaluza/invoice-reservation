import { Injectable } from '@nestjs/common';
import { StreamLagRegistry } from '../../shared/stream-lag';
import { CapacityRefusal } from '../domain/errors';
import { PendingLedgerEntry } from '../domain/ledger-entry';
import { cancelPolicy } from '../domain/policies/cancel.policy';
import { ReservationSnapshot } from '../domain/policies/release.policy';
import { advancePosition } from '../domain/position';
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
  cancelFingerprint,
} from './idempotency.service';
import { ReservationBody, toReservationBody } from './reservation.projection';

export interface CancelCommand {
  readonly organisationId: string;
  readonly programId: string;
  readonly requestId: string;
  readonly invoiceId: string;
  readonly reason: 'CANCELLED' | 'WRITTEN_OFF';
  readonly note: string | null;
  readonly actor: string;
  readonly correlationId: string;
}

export interface CancelBody {
  readonly reservation: ReservationBody;
  readonly availability: AvailabilityBody;
}

export interface CancelOutcome {
  readonly created: boolean;
  readonly body: CancelBody;
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
export class CancelService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly programRepository: ProgramRepository,
    private readonly idempotency: IdempotencyService,
    private readonly streamLag: StreamLagRegistry,
  ) {}

  async cancel(command: CancelCommand): Promise<CancelOutcome> {
    return this.unitOfWork.withProgramLock(
      command.programId,
      async ({ manager, program }): Promise<CancelOutcome> => {
        const now = new Date();

        const identity: RequestIdentity = {
          organisationId: command.organisationId,
          requestId: command.requestId,
          operation: 'CANCEL',
          fingerprint: cancelFingerprint({
            programId: command.programId,
            invoiceId: command.invoiceId,
            reason: command.reason,
            note: command.note ?? '',
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
            body: idempotencyDecision.outcome as unknown as CancelBody,
          };
        }

        // FR-019e: while the program's position cannot be verified, every write
        // is refused — a cancellation returns capacity from the same cached
        // position, so it cannot be vouched for either.
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

        const reservation: ReservationSnapshot = {
          invoiceCurrency: row.invoice_currency,
          programCurrency: row.program_currency,
          outstandingInvoiceMinor: BigInt(row.outstanding_invoice_minor),
          outstandingReservedMinor: BigInt(row.outstanding_reserved_minor),
          status: row.status,
        };

        const decision = cancelPolicy(reservation);

        if (!decision.ok) {
          throw new CapacityRefusal(decision.error);
        }

        // Key Decision 5: the policy states the returned capacity as a positive
        // magnitude; the single ledger entry negates it exactly once.
        const applied = decision.value;
        const ledgerEntry: PendingLedgerEntry = {
          deltaMinor: -applied.deltaMinor,
          component: 'LOCAL',
          cause: applied.cause,
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
              SET outstanding_reserved_minor = $3,
                  status = $4,
                  updated_at = $5
            WHERE program_id = $1 AND invoice_id = $2`,
          [command.programId, command.invoiceId, '0', applied.status, now],
        );
        const updatedRow: InvoiceReservationRow = {
          ...row,
          outstanding_reserved_minor: '0',
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
        const body: CancelBody = {
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
