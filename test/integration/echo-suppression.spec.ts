import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../../src/config/data-source';
import { PostgresFixture, startPostgres } from '../support/postgres-container';
import {
  buildTreasuryHarness,
  capacityEventMessage,
  insertLocalReservation,
  insertOrganisation,
  insertProgram,
  TreasuryHarness,
} from '../support/treasury';

jest.setTimeout(180_000);

describe('Capacity event echo suppression (T070)', () => {
  let fixture: PostgresFixture;
  let ds: DataSource;
  let harness: TreasuryHarness;
  let programId: string;

  beforeAll(async () => {
    fixture = await startPostgres();

    ds = new DataSource({
      ...dataSourceOptions,
      url: fixture.ownerUrl,
      entities: [],
    });
    await ds.initialize();
    await ds.runMigrations();

    const organisationId = await insertOrganisation(ds, 't070-org');

    programId = await insertProgram(ds, organisationId, {
      currency: 'USD',
      creditLimitMinor: 1_000_000,
      localReservedMinor: 1000,
      treasuryReservedMinor: 0,
    });

    await insertLocalReservation(ds, programId, {
      invoiceId: 'INV-ECHO-1',
      amountMinor: 1000,
      treasuryReference: 'TRSY-REF-1',
    });

    harness = buildTreasuryHarness(ds);
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.destroy();
    }
    await fixture?.stop();
  });

  it('skips an event naming a reservation this service originated and acknowledges it', async () => {
    const message = capacityEventMessage({
      programId,
      messageId: 'msg-echo-0001',
      type: 'RESERVATION_BOOKED',
      reservationReference: 'TRSY-REF-1',
      amountMinor: '300',
      version: 1,
    });

    await expect(harness.handler.handle(message)).resolves.toEqual({
      kind: 'skipped',
    });

    const position = await ds.query<
      { treasury_reserved_minor: string; local_reserved_minor: string }[]
    >(
      `SELECT treasury_reserved_minor, local_reserved_minor FROM program WHERE id = $1`,
      [programId],
    );
    expect(position[0]?.treasury_reserved_minor).toBe('0');
    expect(position[0]?.local_reserved_minor).toBe('1000');

    const processed = await ds.query<{ count: string }[]>(
      `SELECT count(*) FROM processed_message WHERE message_id = $1`,
      ['msg-echo-0001'],
    );
    expect(processed[0]?.count).toBe('1');

    const ledger = await ds.query<{ count: string }[]>(
      `SELECT count(*) FROM capacity_ledger_entry WHERE program_id = $1`,
      [programId],
    );
    expect(ledger[0]?.count).toBe('0');

    const reservation = await ds.query<
      { treasury_acknowledged: boolean; acknowledged_by_version: string }[]
    >(
      `SELECT treasury_acknowledged, acknowledged_by_version
         FROM invoice_reservation
        WHERE program_id = $1 AND invoice_id = $2`,
      [programId, 'INV-ECHO-1'],
    );
    expect(reservation[0]?.treasury_acknowledged).toBe(true);
    // pg returns BIGINT columns as strings.
    expect(reservation[0]?.acknowledged_by_version).toBe('1');
  });

  it('applies a LIMIT_CHANGED carrying a reservation reference instead of treating it as an echo', async () => {
    const before = await ds.query<{ credit_limit_minor: string }[]>(
      `SELECT credit_limit_minor FROM program WHERE id = $1`,
      [programId],
    );
    const newLimit = (BigInt(before[0]?.credit_limit_minor ?? '0') + 500n).toString();

    const message = capacityEventMessage({
      programId,
      messageId: 'msg-limit-with-ref-0001',
      type: 'LIMIT_CHANGED',
      reservationReference: 'TRSY-REF-1',
      amountMinor: newLimit,
      version: 2,
    });

    await expect(harness.handler.handle(message)).resolves.toEqual({
      kind: 'applied',
    });

    const after = await ds.query<{ credit_limit_minor: string }[]>(
      `SELECT credit_limit_minor FROM program WHERE id = $1`,
      [programId],
    );
    expect(after[0]?.credit_limit_minor).toBe(newLimit);
  });
});
