import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../../src/config/data-source';
import { IdempotencyService } from '../../src/capacity/application/idempotency.service';
import { ReleaseService } from '../../src/capacity/application/release.service';
import { ReserveService } from '../../src/capacity/application/reserve.service';
import { ProgramRepository } from '../../src/capacity/infrastructure/repositories/program.repository';
import { UnitOfWork } from '../../src/capacity/infrastructure/unit-of-work';
import { CachedRateProvider } from '../../src/fx/cached-rate.provider';
import { StreamLagRegistry } from '../../src/shared/stream-lag';
import { PostgresFixture, startPostgres } from '../support/postgres-container';
import {
  buildTreasuryHarness,
  insertLocalReservation,
  insertOrganisation,
  insertProgram,
  snapshotMessage,
  TreasuryHarness,
} from '../support/treasury';

jest.setTimeout(180_000);

interface ProgramRow {
  over_limit_since: Date | null;
}

interface LedgerRow {
  cause: string;
}

describe('Over-limit onset and clearance (T084)', () => {
  let fixture: PostgresFixture;
  let ds: DataSource;
  let harness: TreasuryHarness;
  let reserves: ReserveService;
  let releases: ReleaseService;
  let organisationId: string;
  let programId: string;

  const readProgram = async (): Promise<ProgramRow> => {
    const rows = await ds.query<ProgramRow[]>(
      `SELECT over_limit_since FROM program WHERE id = $1`,
      [programId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('program not found');
    return row;
  };

  const readCauses = async (): Promise<string[]> => {
    const rows = await ds.query<LedgerRow[]>(
      `SELECT cause FROM capacity_ledger_entry WHERE program_id = $1 ORDER BY sequence`,
      [programId],
    );
    return rows.map((row) => row.cause);
  };

  beforeAll(async () => {
    fixture = await startPostgres();

    ds = new DataSource({
      ...dataSourceOptions,
      url: fixture.ownerUrl,
      entities: [],
    });
    await ds.initialize();
    await ds.runMigrations();

    organisationId = await insertOrganisation(ds, 't084-org');
    programId = await insertProgram(ds, organisationId, {
      currency: 'USD',
      creditLimitMinor: 10_000_000,
      localReservedMinor: 8_000_000,
    });
    await insertLocalReservation(ds, programId, {
      invoiceId: 'inv-over-funded',
      amountMinor: 8_000_000,
      treasuryReference: 'TRSY-OVER',
    });

    harness = buildTreasuryHarness(ds);
    reserves = new ReserveService(
      new UnitOfWork(ds),
      new ProgramRepository(),
      new IdempotencyService(),
      new CachedRateProvider(ds),
      new StreamLagRegistry(),
    );
    releases = new ReleaseService(
      new UnitOfWork(ds),
      new ProgramRepository(),
      new IdempotencyService(),
      new StreamLagRegistry(),
    );
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.destroy();
    }
    await fixture?.stop();
  });

  it('records onset and refuses every new reservation while over-limit', async () => {
    await expect(
      harness.snapshotHandler.handle(
        snapshotMessage({
          programId,
          messageId: 'snap-t084-cut',
          version: 40,
          reservedMinor: '0',
          creditLimitMinor: '5000000',
        }),
      ),
    ).resolves.toEqual({ kind: 'applied' });

    expect((await readProgram()).over_limit_since).not.toBeNull();
    expect(await readCauses()).toContain('OVER_LIMIT_ONSET');

    for (const invoiceId of ['inv-over-new-1', 'inv-over-new-2']) {
      await expect(
        reserves.reserve({
          organisationId,
          programId,
          requestId: `res-t084-${invoiceId}`,
          invoiceId,
          amountMinor: 1_000n,
          currency: 'USD',
          actor: 't084-tester',
          correlationId: `corr-t084-${invoiceId}`,
        }),
      ).rejects.toMatchObject({ code: 'PROGRAM_OVER_LIMIT' });
    }

    const reservations = await ds.query<{ count: number }[]>(
      `SELECT count(*)::int AS count
         FROM capacity_ledger_entry
        WHERE program_id = $1 AND cause = 'RESERVATION'`,
      [programId],
    );
    expect(reservations[0]?.count).toBe(0);
  });

  it('records clearance once releases bring the total back within the limit', async () => {
    await releases.release({
      organisationId,
      programId,
      requestId: 'rel-t084',
      invoiceId: 'inv-over-funded',
      releaseMinor: 4_000_000n,
      currency: 'USD',
      actor: 't084-tester',
      correlationId: 'corr-t084-rel',
    });

    expect((await readProgram()).over_limit_since).toBeNull();
    expect(await readCauses()).toContain('OVER_LIMIT_CLEARED');
  });
});
