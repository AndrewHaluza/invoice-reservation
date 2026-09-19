import { Inject, Injectable } from '@nestjs/common';
import { reservationOutcomesTotal } from '../../observability/metrics';
import { CapacityRefusal } from '../domain/errors';
import { PendingLedgerEntry } from '../domain/ledger-entry';
import {
  FX_RATE_PROVIDER,
  FxRateProvider,
} from '../domain/ports/fx-rate.provider';
import { advancePosition } from '../domain/position';
import { FxResolution, decideReservation } from '../domain/policies/reserve.policy';
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

export interface ReserveCommand {
  readonly organisationId: string;
  readonly programId: string;
  readonly requestId: string;
  readonly invoiceId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly actor: string;
  readonly correlationId: string;
}

export interface ReserveBody {
  readonly reservation: ReservationBody;
  readonly availability: AvailabilityBody;
}

export interface ReserveOutcome {
  readonly created: boolean;
  readonly body: ReserveBody;
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
export class ReserveService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly programRepository: ProgramRepository,
    private readonly idempotency: IdempotencyService,
    @Inject(FX_RATE_PROVIDER) private readonly fxRateProvider: FxRateProvider,
  ) {}

  async reserve(command: ReserveCommand): Promise<ReserveOutcome> {
    return this.unitOfWork.withProgramLock(
      command.programId,
      async ({ manager, program }): Promise<ReserveOutcome> => {
        const now = new Date();

        const identity: RequestIdentity = {
          organisationId: command.organisationId,
          requestId: command.requestId,
          operation: 'RESERVE',
          fingerprint: reserveFingerprint({
            programId: command.programId,
            invoiceId: command.invoiceId,
            amountMinor: command.amountMinor.toString(),
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
            body: idempotencyDecision.outcome as unknown as ReserveBody,
          };
        }

        const duplicate = await manager.query<{ present: number }[]>(
          `SELECT 1 AS present
             FROM invoice_reservation
            WHERE program_id = $1 AND invoice_id = $2`,
          [command.programId, command.invoiceId],
        );
        if (duplicate.length > 0) {
          throw new CapacityRefusal('DUPLICATE_INVOICE');
        }

        let fx: FxResolution;
        if (command.currency === program.currency) {
          fx = { kind: 'sameCurrency' };
        } else {
          const rate = await this.fxRateProvider.rateFor(
            command.currency,
            program.currency,
            now,
          );
          fx = rate === null ? { kind: 'unavailable' } : { kind: 'rate', rate };
        }

        const decision = decideReservation({
          program: this.programRepository.toPosition(program),
          invoiceAmountMinor: command.amountMinor,
          fx,
        });

        if (decision.kind === 'refused') {
          reservationOutcomesTotal.labels('refused', decision.code).inc();
          throw new CapacityRefusal(decision.code, decision.details);
        }

        const appliedFx = decision.fx;
        const insertedRows = await manager.query<InvoiceReservationRow[]>(
          `INSERT INTO invoice_reservation
             (program_id, invoice_id, invoice_amount_minor, invoice_currency,
              program_currency, reserved_minor, outstanding_invoice_minor,
              outstanding_reserved_minor, fx_rate, fx_rate_effective_at,
              fx_rate_source, status, origin, treasury_acknowledged,
              acknowledged_by_version, treasury_reference, confirmed_at,
              created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'ACTIVE',
                   'LOCAL', FALSE, NULL, NULL, $12, $12, $12)
           RETURNING *`,
          [
            command.programId,
            command.invoiceId,
            command.amountMinor.toString(),
            command.currency,
            program.currency,
            decision.reservedMinor.toString(),
            command.amountMinor.toString(),
            decision.reservedMinor.toString(),
            appliedFx?.rate ?? null,
            appliedFx?.effectiveAt ?? null,
            appliedFx?.source ?? null,
            now,
          ],
        );
        const insertedRow = insertedRows[0];
        if (insertedRow === undefined) {
          throw new Error('failed to insert invoice reservation');
        }

        const ledgerEntry: PendingLedgerEntry = {
          deltaMinor: decision.reservedMinor,
          component: 'LOCAL',
          cause: 'RESERVATION',
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

        // `advancePosition` carries the position fields only, so the entity's
        // `positionChangedAt` would still be the value read under the lock.
        // `persistAdvance` just wrote `position_changed_at = now`; mirror it so
        // the response agrees with the row.
        const programAfter: ProgramEntity = {
          ...program,
          ...result.program,
          positionChangedAt: now,
        };
        const body: ReserveBody = {
          reservation: toReservationBody(
            toInvoiceReservationEntity(insertedRow),
          ),
          availability: toAvailabilityBody(programAfter, false),
        };

        await this.idempotency.complete(
          manager,
          identity,
          body as unknown as Record<string, unknown>,
        );

        reservationOutcomesTotal.labels('accepted', 'none').inc();
        return { created: true, body };
      },
    );
  }
}
