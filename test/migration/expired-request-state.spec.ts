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

describe('AddExpiredRequestState migration', () => {
  let fixture: PostgresFixture;
  let ds: DataSource;
  let organisationId: string;

  beforeAll(async () => {
    fixture = await startPostgres();

    ds = new DataSource({
      ...dataSourceOptions,
      url: fixture.ownerUrl,
      entities: [],
    });
    await ds.initialize();
    await ds.runMigrations();

    const rows = await ds.query<{ id: string }[]>(
      `INSERT INTO organisation (name) VALUES ($1) RETURNING id`,
      ['expired-state'],
    );
    const organisation = rows[0];
    if (!organisation) {
      throw new Error('Expected the organisation insert to return one row');
    }
    organisationId = organisation.id;
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.destroy();
    }
    await fixture?.stop();
  });

  it('adds EXPIRED to the request_state enum', async () => {
    const rows = await ds.query<{ value: string }[]>(
      `SELECT unnest(enum_range(NULL::request_state))::text AS value`,
    );
    expect(rows.map((row) => row.value)).toEqual([
      'PENDING',
      'COMPLETE',
      'EXPIRED',
    ]);
  });

  it('permits an EXPIRED row with a null outcome', async () => {
    await ds.query(
      `INSERT INTO request_record
        (organisation_id, request_id, operation, content_fingerprint, state, outcome)
       VALUES ($1, $2, $3, $4, 'EXPIRED', NULL)`,
      [organisationId, 'expired', 'RESERVE', 'fp'],
    );

    const rows = await ds.query<{ state: string; outcome: unknown }[]>(
      `SELECT state, outcome FROM request_record
        WHERE organisation_id = $1 AND request_id = $2`,
      [organisationId, 'expired'],
    );
    expect(rows[0]?.state).toBe('EXPIRED');
    expect(rows[0]?.outcome ?? null).toBeNull();
  });

  it('still refuses a COMPLETE row with a null outcome with SQLSTATE 23514', async () => {
    let error: unknown;
    try {
      await ds.query(
        `INSERT INTO request_record
          (organisation_id, request_id, operation, content_fingerprint, state, outcome)
         VALUES ($1, $2, $3, $4, 'COMPLETE', NULL)`,
        [organisationId, 'complete-null', 'RESERVE', 'fp'],
      );
    } catch (caught) {
      error = caught;
    }
    if (error === undefined) {
      throw new Error('Expected the insert to fail with SQLSTATE 23514');
    }
    expect(sqlState(error)).toBe('23514');
  });
});
