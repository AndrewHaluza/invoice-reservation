import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../../src/config/data-source';
import { ReleaseService } from '../../src/capacity/application/release.service';
import { IdempotencyService } from '../../src/capacity/application/idempotency.service';
import { ProgramRepository } from '../../src/capacity/infrastructure/repositories/program.repository';
import { UnitOfWork } from '../../src/capacity/infrastructure/unit-of-work';
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
  credit_limit_minor: string;
  over_limit_since: Date | null;
}

interface LedgerRow {
  cause: string;
  component: string;
  delta_minor: string;
}

describe('Limit reduction below local reservations (T083)', () => {
  let fixture: PostgresFixture;
  let ds: DataSource;
  let harness: TreasuryHarness;
  let releases: ReleaseService;
  let organisationId: string;
  let programId: string;

  const readProgram = async (): Promise<ProgramRow> => {
    const rows = await ds.query<ProgramRow[]>(
      `SELECT credit_limit_minor::text AS credit_limit_minor, over_limit_since
         FROM program WHERE id = $1`,
      [programId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('program not found');
    return row;
  };

  const readLedger = (): Promise<LedgerRow[]> =>
    ds.query<LedgerRow[]>(
      `SELECT cause, component, delta_minor::text AS delta_minor
         FROM capacity_ledger_entry WHERE program_id = $1 ORDER BY sequence`,
      [programId],
    );

  beforeAll(async () => {
    fixture = await startPostgres();

    ds = new DataSource({
      ...dataSourceOptions,
      url: fixture.ownerUrl,
      entities: [],
    });
    await ds.initialize();
    await ds.runMigrations();

    organisationId = await insertOrganisation(ds, 't083-org');
    programId = await insertProgram(ds, organisationId, {
      currency: 'USD',
      creditLimitMinor: 1_200_000_000,
      localReservedMinor: 8_000_000,
    });
    await insertLocalReservation(ds, programId, {
      invoiceId: 'inv-limit-cut',
      amountMinor: 8_000_000,
      treasuryReference: 'TRSY-LIMIT',
    });

    harness = buildTreasuryHarness(ds);
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

  it('applies a limit cut below local reservations and marks the program over-limit', async () => {
    await expect(
      harness.snapshotHandler.handle(
        snapshotMessage({
          programId,
          messageId: 'snap-t083-cut',
          version: 30,
          reservedMinor: '0',
          creditLimitMinor: '5000000',
        }),
      ),
    ).resolves.toEqual({ kind: 'applied' });

    const program = await readProgram();
    expect(program.credit_limit_minor).toBe('5000000');
    expect(program.over_limit_since).not.toBeNull();

    const ledger = await readLedger();
    expect(ledger).toContainEqual({
      cause: 'RECONCILIATION_ADJUSTMENT',
      component: 'LIMIT',
      delta_minor: '-1195000000',
    });
    expect(ledger).toContainEqual({
      cause: 'OVER_LIMIT_ONSET',
      component: 'LIMIT',
      delta_minor: '0',
    });
  });

  it('clears the mark automatically once releases bring the total back within the limit', async () => {
    await releases.release({
      organisationId,
      programId,
      requestId: 'rel-t083',
      invoiceId: 'inv-limit-cut',
      releaseMinor: 4_000_000n,
      currency: 'USD',
      actor: 't083-tester',
      correlationId: 'corr-t083',
    });

    const program = await readProgram();
    expect(program.over_limit_since).toBeNull();

    const ledger = await readLedger();
    expect(ledger).toContainEqual({
      cause: 'OVER_LIMIT_CLEARED',
      component: 'LIMIT',
      delta_minor: '0',
    });
  });
});
