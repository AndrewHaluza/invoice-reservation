import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { auditLedger } from '../../scripts/audit-ledger';
import { dataSourceOptions } from '../../src/config/data-source';
import { CapacityEvent, StreamCoordinates } from '../../src/shared/treasury/capacity-event';
import { parseCapacityEvent } from '../../src/treasury/schemas/capacity-event.schema';
import { PostgresFixture, startPostgres } from '../support/postgres-container';
import {
  buildTreasuryHarness,
  capacityEventMessage,
  EventOverrides,
  insertLocalReservation,
  insertOrganisation,
  insertProgram,
  TreasuryHarness,
} from '../support/treasury';

jest.setTimeout(300_000);

const TOPIC = 'treasury.capacity.events';
const LIMIT_MINOR = 1_000_000;
const INVOICE_ID = 'INV-1';
const LOCAL_AMOUNT_MINOR = 100_000;
const OFFSET_0_AMOUNT = 50_000;
const OFFSET_1_AMOUNT = 30_000;
const OFFSET_2_AMOUNT = 20_000;

const MESSAGE_IDS = ['msg-offset-0', 'msg-offset-1', 'msg-offset-2'] as const;
const VERSIONS = [1, 2, 3] as const;

const BASE_TABLES = [
  'program',
  'invoice_reservation',
  'capacity_ledger_entry',
  'program_stream_position',
  'processed_message',
] as const;

const coordinates = (offset: string): StreamCoordinates => ({
  topic: TOPIC,
  partition: 0,
  offset,
});

interface ProgramRow {
  readonly local_reserved_minor: string;
  readonly treasury_reserved_minor: string;
  readonly credit_limit_minor: string;
}

interface StreamPositionRow {
  readonly offset: string;
}

interface CountRow {
  readonly count: string;
}

interface ReservationRow {
  readonly invoice_amount_minor: string;
  readonly reserved_minor: string;
}

const toEvent = (overrides: EventOverrides): CapacityEvent => {
  const parsed = parseCapacityEvent(capacityEventMessage(overrides).value);
  if (!parsed.ok) {
    throw new Error(`expected a valid capacity event: ${parsed.detail}`);
  }
  return parsed.event;
};

describe('Ledger recovery (SC-010 / FR-019c / FR-019d)', () => {
  let postgres: PostgresFixture;
  let owner: DataSource;
  let harness: TreasuryHarness;

  let organisationId: string;
  let programId: string;

  let processedCount: number;
  let ledgerCount: number;

  const readProgram = async (): Promise<ProgramRow> => {
    const rows = await owner.query<ProgramRow[]>(
      `SELECT local_reserved_minor, treasury_reserved_minor, credit_limit_minor
         FROM program
        WHERE id = $1`,
      [programId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('expected the program row to exist');
    return row;
  };

  const readStreamOffset = async (): Promise<string> => {
    const rows = await owner.query<StreamPositionRow[]>(
      `SELECT "offset" FROM program_stream_position
        WHERE program_id = $1 AND topic = $2 AND partition = 0`,
      [programId, TOPIC],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('expected a recorded stream position');
    return row.offset;
  };

  const countProcessed = async (): Promise<number> => {
    const rows = await owner.query<CountRow[]>(
      `SELECT COUNT(*)::text AS count
         FROM processed_message
        WHERE program_id = $1`,
      [programId],
    );
    return Number(rows[0]?.count ?? '0');
  };

  const countLedger = async (): Promise<number> => {
    const rows = await owner.query<CountRow[]>(
      `SELECT COUNT(*)::text AS count
         FROM capacity_ledger_entry
        WHERE program_id = $1`,
      [programId],
    );
    return Number(rows[0]?.count ?? '0');
  };

  const applyAt = async (index: 0 | 1 | 2): Promise<{ kind: string }> => {
    const event = toEvent({
      programId,
      messageId: MESSAGE_IDS[index],
      version: VERSIONS[index],
      type: 'RESERVATION_BOOKED',
      amountMinor: String([OFFSET_0_AMOUNT, OFFSET_1_AMOUNT, OFFSET_2_AMOUNT][index]),
      reservationReference: null,
      topic: TOPIC,
      partition: 0,
      offset: String(index),
    });
    return harness.applyService.apply(event, coordinates(String(index)));
  };

  beforeAll(async () => {
    postgres = await startPostgres();

    owner = new DataSource({
      ...dataSourceOptions,
      url: postgres.ownerUrl,
      entities: [],
    });
    await owner.initialize();
    await owner.runMigrations();

    organisationId = await insertOrganisation(owner, 't093-org');
    programId = await insertProgram(owner, organisationId, {
      currency: 'USD',
      creditLimitMinor: LIMIT_MINOR,
      localReservedMinor: LOCAL_AMOUNT_MINOR,
      treasuryVersion: 0,
    });

    // Opening position entries, mirroring how the seed records the limit and how
    // the reserve path records a LOCAL booking. Without them the ledger could not
    // reconcile to the cached columns (SC-004 / FR-019a) that step 8 asserts.
    const now = new Date('2026-01-01T00:00:00.000Z');
    await owner.query(
      `INSERT INTO capacity_ledger_entry
         (program_id, sequence, delta_minor, component, cause,
          origin_reference, actor, correlation_id, occurred_at)
       VALUES
         ($1, 0, $2, 'LOCAL', 'RESERVATION', $3, 'ledger-recovery', 't093-local', $4),
         ($1, 1, $5, 'LIMIT', 'LIMIT_CHANGE', NULL, 'ledger-recovery', 't093-limit', $4)`,
      [programId, LOCAL_AMOUNT_MINOR, INVOICE_ID, now, LIMIT_MINOR],
    );
    await owner.query(`UPDATE program SET next_sequence = 2 WHERE id = $1`, [
      programId,
    ]);

    await insertLocalReservation(owner, programId, {
      invoiceId: INVOICE_ID,
      amountMinor: LOCAL_AMOUNT_MINOR,
      treasuryReference: null,
    });

    harness = buildTreasuryHarness(owner);
  });

  afterAll(async () => {
    if (owner?.isInitialized) {
      await owner.destroy();
    }
    await postgres?.stop();
  });

  it('is present after seeding', async () => {
    const reservation = await owner.query<ReservationRow[]>(
      `SELECT invoice_amount_minor, reserved_minor
         FROM invoice_reservation
        WHERE program_id = $1 AND invoice_id = $2`,
      [programId, INVOICE_ID],
    );
    expect(reservation[0]?.reserved_minor).toBe(String(LOCAL_AMOUNT_MINOR));
  });

  it('applies the first two treasury events and records the per-program position', async () => {
    await expect(applyAt(0)).resolves.toEqual({ kind: 'applied' });
    await expect(applyAt(1)).resolves.toEqual({ kind: 'applied' });

    const position = await readProgram();
    expect(position.local_reserved_minor).toBe(String(LOCAL_AMOUNT_MINOR));
    expect(position.treasury_reserved_minor).toBe(
      String(OFFSET_0_AMOUNT + OFFSET_1_AMOUNT),
    );
    expect(await readStreamOffset()).toBe('1');
  });

  it('restores a ledger backup and keeps the recorded position', async () => {
    await owner.query(`CREATE SCHEMA ledger_backup`);
    for (const table of BASE_TABLES) {
      await owner.query(
        `CREATE TABLE ledger_backup.${table} AS TABLE public.${table}`,
      );
    }

    await owner.query(
      `TRUNCATE TABLE capacity_ledger_entry, program_stream_position,
         invoice_reservation, processed_message, program CASCADE`,
    );
    for (const table of BASE_TABLES) {
      await owner.query(
        `INSERT INTO public.${table} SELECT * FROM ledger_backup.${table}`,
      );
    }

    const position = await readProgram();
    expect(position.local_reserved_minor).toBe(String(LOCAL_AMOUNT_MINOR));
    expect(position.treasury_reserved_minor).toBe(
      String(OFFSET_0_AMOUNT + OFFSET_1_AMOUNT),
    );
    expect(await readStreamOffset()).toBe('1');

    processedCount = await countProcessed();
    ledgerCount = await countLedger();
  });

  it('re-delivers the applied messages without applying them twice', async () => {
    await expect(applyAt(0)).resolves.toEqual({ kind: 'already_applied' });
    await expect(applyAt(1)).resolves.toEqual({ kind: 'already_applied' });

    const position = await readProgram();
    expect(position.treasury_reserved_minor).toBe(
      String(OFFSET_0_AMOUNT + OFFSET_1_AMOUNT),
    );
    expect(await readStreamOffset()).toBe('1');
    expect(await countProcessed()).toBe(processedCount);
    expect(await countLedger()).toBe(ledgerCount);
  });

  it('applies the next event exactly once from the recorded position', async () => {
    await expect(applyAt(2)).resolves.toEqual({ kind: 'applied' });

    const position = await readProgram();
    expect(position.treasury_reserved_minor).toBe(
      String(OFFSET_0_AMOUNT + OFFSET_1_AMOUNT + OFFSET_2_AMOUNT),
    );
    expect(await readStreamOffset()).toBe('2');
    expect(await countProcessed()).toBe(processedCount + 1);
    expect(await countLedger()).toBe(ledgerCount + 1);
  });

  it('reconciles the ledger and retains the local reservation', async () => {
    const audit = await auditLedger(owner);
    expect(audit.mismatch).toBeNull();
    expect(audit.programsChecked).toBe(1);

    const local = await owner.query<CountRow[]>(
      `SELECT COALESCE(SUM(delta_minor), 0)::text AS count
         FROM capacity_ledger_entry
        WHERE program_id = $1 AND component = 'LOCAL'`,
      [programId],
    );
    const treasury = await owner.query<CountRow[]>(
      `SELECT COALESCE(SUM(delta_minor), 0)::text AS count
         FROM capacity_ledger_entry
        WHERE program_id = $1 AND component = 'TREASURY'`,
      [programId],
    );
    const position = await readProgram();
    expect(local[0]?.count).toBe(position.local_reserved_minor);
    expect(treasury[0]?.count).toBe(position.treasury_reserved_minor);

    const reservation = await owner.query<ReservationRow[]>(
      `SELECT invoice_amount_minor, reserved_minor
         FROM invoice_reservation
        WHERE program_id = $1 AND invoice_id = $2`,
      [programId, INVOICE_ID],
    );
    expect(reservation[0]?.invoice_amount_minor).toBe(
      String(LOCAL_AMOUNT_MINOR),
    );
    expect(reservation[0]?.reserved_minor).toBe(String(LOCAL_AMOUNT_MINOR));
  });
});
