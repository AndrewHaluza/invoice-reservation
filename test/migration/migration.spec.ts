import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../../src/config/data-source';
import { PostgresFixture, startPostgres } from '../support/postgres-container';

jest.setTimeout(180_000);

interface SqlErrorLike {
  code?: unknown;
  driverError?: { code?: unknown };
}

function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const candidate = error as SqlErrorLike;
  const code = candidate.code ?? candidate.driverError?.code;
  return typeof code === 'string' ? code : undefined;
}

async function expectSqlState(
  operation: Promise<unknown>,
  expected: string,
): Promise<void> {
  let error: unknown;
  try {
    await operation;
  } catch (caught) {
    error = caught;
  }
  if (error === undefined) {
    throw new Error(`Expected the statement to fail with SQLSTATE ${expected}`);
  }
  expect(sqlState(error)).toBe(expected);
}

async function insertReturningId(
  source: DataSource,
  sql: string,
  parameters: unknown[],
): Promise<string> {
  const rows = await source.query<{ id: string }[]>(sql, parameters);
  const row = rows[0];
  if (!row) {
    throw new Error('Expected the insert to return exactly one row');
  }
  return row.id;
}

describe('InitialSchema migration', () => {
  let fixture: PostgresFixture;
  let ds: DataSource;
  let appDs: DataSource;
  let programAfterDown: string | null | undefined;

  const newOrganisation = (name: string): Promise<string> =>
    insertReturningId(
      ds,
      `INSERT INTO organisation (name) VALUES ($1) RETURNING id`,
      [name],
    );

  const newProgram = (
    organisationId: string,
    currency: string,
    creditLimitMinor: number | string,
    localReservedMinor: number | string,
  ): Promise<string> =>
    insertReturningId(
      ds,
      `INSERT INTO program
        (organisation_id, currency, credit_limit_minor, local_reserved_minor)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [organisationId, currency, creditLimitMinor, localReservedMinor],
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
    for (;;) {
      const applied = await ds.query<{ id: number }[]>(
        `SELECT id FROM typeorm_migrations`,
      );
      if (applied.length === 0) {
        break;
      }
      await ds.undoLastMigration();
    }

    const rows = await ds.query<{ reg: string | null }[]>(
      `SELECT to_regclass('public.program') AS reg`,
    );
    programAfterDown = rows[0]?.reg;

    await ds.runMigrations();

    appDs = new DataSource({
      ...dataSourceOptions,
      url: fixture.appUrl,
      entities: [],
      migrations: [],
    });
    await appDs.initialize();
  });

  afterAll(async () => {
    if (appDs?.isInitialized) {
      await appDs.destroy();
    }
    if (ds?.isInitialized) {
      await ds.destroy();
    }
    await fixture?.stop();
  });

  it('applies up, reverses down (dropping the schema), then applies up again', async () => {
    expect(programAfterDown).toBeNull();

    const rows = await ds.query<{ reg: string | null }[]>(
      `SELECT to_regclass('public.program') AS reg`,
    );
    expect(rows[0]?.reg).toBe('program');
  });

  it('permits a credit-limit reduction below the current local reservation (FR-011c)', async () => {
    const organisationId = await newOrganisation('limit-reduction');
    const programId = await newProgram(organisationId, 'USD', 1000, 0);

    await ds.query(
      `UPDATE program SET local_reserved_minor = $1 WHERE id = $2`,
      [800, programId],
    );
    await ds.query(`UPDATE program SET credit_limit_minor = $1 WHERE id = $2`, [
      500,
      programId,
    ]);

    const rows = await ds.query<
      { credit_limit_minor: string; local_reserved_minor: string }[]
    >(
      `SELECT credit_limit_minor, local_reserved_minor FROM program WHERE id = $1`,
      [programId],
    );
    expect(rows[0]?.credit_limit_minor).toBe('500');
    expect(rows[0]?.local_reserved_minor).toBe('800');
  });

  it('refuses a local-reservation increase past the limit with SQLSTATE 23514', async () => {
    const organisationId = await newOrganisation('over-limit');
    const programId = await newProgram(organisationId, 'USD', 1000, 0);

    await ds.query(
      `UPDATE program SET local_reserved_minor = $1 WHERE id = $2`,
      [800, programId],
    );
    await ds.query(`UPDATE program SET credit_limit_minor = $1 WHERE id = $2`, [
      500,
      programId,
    ]);

    await expectSqlState(
      ds.query(`UPDATE program SET local_reserved_minor = $1 WHERE id = $2`, [
        900,
        programId,
      ]),
      '23514',
    );
  });

  it('keeps the ledger append-only for the application role', async () => {
    const organisationId = await newOrganisation('append-only');
    const programId = await newProgram(organisationId, 'USD', 1000, 0);

    await appDs.query(
      `INSERT INTO capacity_ledger_entry
        (program_id, sequence, delta_minor, component, cause, actor, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [programId, 1, 100, 'LOCAL', 'RESERVATION', 'test', 'corr-1'],
    );

    await expectSqlState(
      appDs.query(`UPDATE capacity_ledger_entry SET delta_minor = $1`, [1]),
      '42501',
    );
    await expectSqlState(appDs.query(`DELETE FROM capacity_ledger_entry`), '42501');
  });

  it("treats request_record's key as composite", async () => {
    const organisationA = await newOrganisation('request-a');
    const organisationB = await newOrganisation('request-b');

    await ds.query(
      `INSERT INTO request_record
        (organisation_id, request_id, operation, content_fingerprint, state)
       VALUES ($1, $2, $3, $4, $5)`,
      [organisationA, 'req-1', 'op', 'fp', 'PENDING'],
    );
    await ds.query(
      `INSERT INTO request_record
        (organisation_id, request_id, operation, content_fingerprint, state)
       VALUES ($1, $2, $3, $4, $5)`,
      [organisationB, 'req-1', 'op', 'fp', 'PENDING'],
    );

    await expectSqlState(
      ds.query(
        `INSERT INTO request_record
          (organisation_id, request_id, operation, content_fingerprint, state)
         VALUES ($1, $2, $3, $4, $5)`,
        [organisationA, 'req-1', 'op', 'fp', 'PENDING'],
      ),
      '23505',
    );
  });

  it('binds the FX check in both directions', async () => {
    const organisationId = await newOrganisation('fx-directions');
    const programId = await newProgram(organisationId, 'USD', 1000, 0);

    await expectSqlState(
      ds.query(
        `INSERT INTO invoice_reservation
          (program_id, invoice_id, invoice_amount_minor, invoice_currency,
           program_currency, reserved_minor, outstanding_invoice_minor,
           outstanding_reserved_minor, fx_rate, status, origin)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          programId,
          'inv-equal-currencies',
          100,
          'USD',
          'USD',
          100,
          0,
          0,
          1.5,
          'ACTIVE',
          'LOCAL',
        ],
      ),
      '23514',
    );

    await expectSqlState(
      ds.query(
        `INSERT INTO invoice_reservation
          (program_id, invoice_id, invoice_amount_minor, invoice_currency,
           program_currency, reserved_minor, outstanding_invoice_minor,
           outstanding_reserved_minor, fx_rate, status, origin)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          programId,
          'inv-differing-currencies',
          100,
          'EUR',
          'USD',
          100,
          0,
          0,
          null,
          'ACTIVE',
          'LOCAL',
        ],
      ),
      '23514',
    );
  });

  it('adds a nullable treasury_applied_effective_at that reverses cleanly', async () => {
    const appliedColumn = async (): Promise<
      { is_nullable: string } | undefined
    > => {
      const rows = await ds.query<{ is_nullable: string }[]>(
        `SELECT is_nullable
           FROM information_schema.columns
          WHERE table_name = 'program'
            AND column_name = 'treasury_applied_effective_at'`,
      );
      return rows[0];
    };

    expect(await appliedColumn()).toEqual({ is_nullable: 'YES' });

    await ds.undoLastMigration();
    expect(await appliedColumn()).toBeUndefined();

    await ds.runMigrations();
    expect(await appliedColumn()).toEqual({ is_nullable: 'YES' });
  });
});
