import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { verify } from 'jsonwebtoken';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../../src/config/data-source';
import { PostgresFixture, startPostgres } from '../support/postgres-container';

jest.setTimeout(180_000);

const JWT_SECRET = 'integration-test-secret-0123456789abcdef';

type SeedModule = typeof import('../../scripts/seed');
type SeedResult = import('../../scripts/seed').SeedResult;

interface Counts {
  organisations: number;
  programs: number;
  fxRates: number;
  ledgerEntries: number;
}

interface ProgramLedgerFact {
  id: string;
  creditLimit: bigint;
  limitSum: bigint;
  limitChangeCount: number;
  firstSequence: bigint | null;
}

const EMPTY_COUNTS: Counts = {
  organisations: 0,
  programs: 0,
  fxRates: 0,
  ledgerEntries: 0,
};

const gitStatus = (): string =>
  execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });

describe('seed script', () => {
  let fixture: PostgresFixture;
  let admin: DataSource;
  let seed: SeedModule;
  let firstRun: SeedResult;
  let countsAfterFirst: Counts = EMPTY_COUNTS;
  let countsAfterSecond: Counts = EMPTY_COUNTS;
  let programFacts: ProgramLedgerFact[] = [];
  let gitBefore = '';
  let gitAfter = '';

  const countTable = async (table: 'organisation' | 'program' | 'fx_rate' | 'capacity_ledger_entry'): Promise<number> => {
    const rows = await admin.query<{ count: number }[]>(
      `SELECT COUNT(*)::int AS count FROM ${table}`,
    );
    return rows[0]?.count ?? -1;
  };

  const readCounts = async (): Promise<Counts> => ({
    organisations: await countTable('organisation'),
    programs: await countTable('program'),
    fxRates: await countTable('fx_rate'),
    ledgerEntries: await countTable('capacity_ledger_entry'),
  });

  const readProgramFacts = async (): Promise<ProgramLedgerFact[]> => {
    const rows = await admin.query<
      {
        id: string;
        credit_limit_minor: string;
        limit_sum: string;
        limit_change_count: number;
        first_sequence: string | null;
      }[]
    >(`
      SELECT p.id,
             p.credit_limit_minor,
             (SELECT COALESCE(SUM(l.delta_minor), 0)::text
                FROM capacity_ledger_entry l
               WHERE l.program_id = p.id AND l.component = 'LIMIT') AS limit_sum,
             (SELECT COUNT(*)::int
                FROM capacity_ledger_entry l
               WHERE l.program_id = p.id AND l.cause = 'LIMIT_CHANGE') AS limit_change_count,
             (SELECT l.sequence::text
                FROM capacity_ledger_entry l
               WHERE l.program_id = p.id AND l.cause = 'LIMIT_CHANGE'
               ORDER BY l.sequence ASC
               LIMIT 1) AS first_sequence
        FROM program p
    `);

    return rows.map((row) => ({
      id: row.id,
      creditLimit: BigInt(row.credit_limit_minor),
      limitSum: BigInt(row.limit_sum),
      limitChangeCount: row.limit_change_count,
      firstSequence: row.first_sequence === null ? null : BigInt(row.first_sequence),
    }));
  };

  beforeAll(async () => {
    fixture = await startPostgres();

    admin = new DataSource({
      ...dataSourceOptions,
      url: fixture.ownerUrl,
      entities: [],
    });
    await admin.initialize();
    await admin.runMigrations();

    gitBefore = gitStatus();

    process.env.DATABASE_URL = fixture.appUrl;
    process.env.JWT_SECRET = JWT_SECRET;

    // data-source.ts reads DATABASE_URL at import time, and postgres-container.ts
    // already pulled it in. Reset the registry so the seed re-reads the env now set.
    jest.resetModules();
    seed = await import('../../scripts/seed');

    firstRun = await seed.runSeed();
    countsAfterFirst = await readCounts();

    await seed.runSeed();
    countsAfterSecond = await readCounts();

    programFacts = await readProgramFacts();
    gitAfter = gitStatus();
  });

  afterAll(async () => {
    if (admin?.isInitialized) {
      await admin.destroy();
    }
    await fixture?.stop();
  });

  it('creates two organisations, three programs and two FX rates', () => {
    expect(countsAfterFirst.organisations).toBe(2);
    expect(countsAfterFirst.programs).toBe(3);
    expect(countsAfterFirst.fxRates).toBe(2);
  });

  it('is idempotent: a second run changes no counts', () => {
    expect(countsAfterSecond).toEqual(countsAfterFirst);
  });

  it('keeps every program credit limit equal to its LIMIT ledger sum', () => {
    expect(programFacts).toHaveLength(3);
    for (const fact of programFacts) {
      expect(fact.creditLimit).toBe(fact.limitSum);
    }
  });

  it('records exactly one LIMIT_CHANGE entry at sequence 1 per program', () => {
    for (const fact of programFacts) {
      expect(fact.limitChangeCount).toBe(1);
      expect(fact.firstSequence).toBe(1n);
    }
  });

  it('seeds the exact EUR to USD rate with source seed', async () => {
    const rows = await admin.query<
      { rate: string; source: string; effective_at: Date }[]
    >(
      `SELECT rate::text AS rate, source, effective_at
         FROM fx_rate
        WHERE base_currency = 'EUR' AND quote_currency = 'USD'`,
    );
    const row = rows[0];
    expect(row).toBeDefined();
    expect(row?.rate).toBe('1.0850000000');
    expect(row?.source).toBe('seed');
    expect(row?.effective_at.getTime()).toBe(0);
  });

  it('mints HS256 tokens that carry all three scopes', async () => {
    const orgRows = await admin.query<{ id: string }[]>(
      `SELECT id FROM organisation ORDER BY id`,
    );
    const orgIds = orgRows.map((row) => row.id).sort();

    expect(firstRun.tokens).toHaveLength(2);
    expect(firstRun.tokens.map((entry) => entry.organisationId).sort()).toEqual(
      orgIds,
    );

    const now = Math.floor(Date.now() / 1000);
    for (const { organisationId, token } of firstRun.tokens) {
      const decoded = verify(token, JWT_SECRET, { algorithms: ['HS256'] });
      expect(typeof decoded).toBe('object');
      const claims = decoded as unknown as Record<string, unknown>;
      expect(claims.org).toBe(organisationId);

      const scopes = String(claims.scope).split(' ');
      const required = [
        'capacity:read',
        'capacity:write',
        'capacity:audit',
      ];
      for (const scope of required) {
        expect(scopes).toContain(scope);
      }

      expect(typeof claims.exp).toBe('number');
      const exp = claims.exp as number;
      expect(exp).toBeGreaterThan(now + 23 * 60 * 60);
      expect(exp).toBeLessThanOrEqual(now + 24 * 60 * 60 + 5);
    }
  });

  it('writes no new files into the repository', () => {
    expect(gitAfter).toBe(gitBefore);
  });
});
