import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ApplyTreasuryEventService } from '../../src/capacity/application/apply-treasury-event.service';
import { ProgramStreamPositionRepository } from '../../src/capacity/infrastructure/repositories/program-stream-position.repository';
import { ProgramRepository } from '../../src/capacity/infrastructure/repositories/program.repository';
import { UnitOfWork } from '../../src/capacity/infrastructure/unit-of-work';
import {
  CapacityEventHandler,
  InboundMessage,
} from '../../src/treasury/handlers/capacity-event.handler';

export interface TreasuryHarness {
  applyService: ApplyTreasuryEventService;
  handler: CapacityEventHandler;
}

export function buildTreasuryHarness(ds: DataSource): TreasuryHarness {
  const unitOfWork = new UnitOfWork(ds);
  const programRepository = new ProgramRepository();
  const streamPositions = new ProgramStreamPositionRepository();
  const applyService = new ApplyTreasuryEventService(
    ds,
    unitOfWork,
    programRepository,
    streamPositions,
  );
  const handler = new CapacityEventHandler(applyService);
  return { applyService, handler };
}

export interface EventOverrides {
  readonly programId: string;
  readonly messageId?: string;
  readonly version?: number;
  readonly effectiveAt?: string;
  readonly correlationId?: string | null;
  readonly type?:
    | 'LIMIT_CHANGED'
    | 'RESERVATION_BOOKED'
    | 'RESERVATION_RELEASED';
  readonly amountMinor?: string;
  readonly currency?: string;
  readonly reservationReference?: string | null;
  readonly topic?: string;
  readonly partition?: number;
  readonly offset?: string;
}

/** Builds an InboundMessage whose value is the JSON of a valid capacity event. */
export function capacityEventMessage(overrides: EventOverrides): InboundMessage {
  const event = {
    messageId: overrides.messageId ?? `msg-${randomUUID()}`,
    programId: overrides.programId,
    version: overrides.version ?? 1,
    effectiveAt: overrides.effectiveAt ?? '2026-01-01T00:00:00.000Z',
    correlationId: overrides.correlationId ?? null,
    type: overrides.type ?? 'RESERVATION_BOOKED',
    payload: {
      amountMinor: overrides.amountMinor ?? '100',
      currency: overrides.currency ?? 'USD',
      reservationReference: overrides.reservationReference ?? null,
    },
  };

  return {
    topic: overrides.topic ?? 'treasury.capacity.events',
    partition: overrides.partition ?? 0,
    offset: overrides.offset ?? '0',
    key: null,
    value: Buffer.from(JSON.stringify(event)),
    headers: {},
  };
}

export async function insertOrganisation(
  ds: DataSource,
  name: string,
): Promise<string> {
  const rows = await ds.query<{ id: string }[]>(
    `INSERT INTO organisation (name) VALUES ($1) RETURNING id`,
    [name],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error('expected organisation insert to return exactly one row');
  }
  return id;
}

export async function insertProgram(
  ds: DataSource,
  organisationId: string,
  options: {
    currency: string;
    creditLimitMinor: number;
    treasuryVersion?: number;
    treasuryEffectiveAt?: Date | null;
    localReservedMinor?: number;
    treasuryReservedMinor?: number;
  },
): Promise<string> {
  const rows = await ds.query<{ id: string }[]>(
    `INSERT INTO program
       (organisation_id, currency, credit_limit_minor, local_reserved_minor,
        treasury_reserved_minor, next_sequence, treasury_version,
        treasury_effective_at, position_changed_at,
        investigation_required, position_verified)
     VALUES ($1, $2, $3, $4, $5, 0, $6, $7, now(), false, true)
     RETURNING id`,
    [
      organisationId,
      options.currency,
      options.creditLimitMinor,
      options.localReservedMinor ?? 0,
      options.treasuryReservedMinor ?? 0,
      options.treasuryVersion ?? 0,
      options.treasuryEffectiveAt ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error('expected program insert to return exactly one row');
  }
  return id;
}

export async function insertLocalReservation(
  ds: DataSource,
  programId: string,
  options: {
    invoiceId: string;
    currency?: string;
    amountMinor?: number;
    treasuryReference: string | null;
  },
): Promise<string> {
  const currency = options.currency ?? 'USD';
  const amountMinor = options.amountMinor ?? 1000;
  const rows = await ds.query<{ id: string }[]>(
    `INSERT INTO invoice_reservation
       (program_id, invoice_id, invoice_amount_minor, invoice_currency,
        program_currency, reserved_minor, outstanding_invoice_minor,
        outstanding_reserved_minor, status, origin, treasury_acknowledged,
        acknowledged_by_version, treasury_reference, confirmed_at,
        created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $3, $3, $3, 'ACTIVE', 'LOCAL', FALSE,
             NULL, $6, now(), now(), now())
     RETURNING id`,
    [
      programId,
      options.invoiceId,
      amountMinor,
      currency,
      currency,
      options.treasuryReference,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error('expected reservation insert to return exactly one row');
  }
  return id;
}
