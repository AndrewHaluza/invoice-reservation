import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sign } from 'jsonwebtoken';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createValidationPipe } from '../../src/shared/validation/create-validation-pipe';
import { PostgresFixture, startPostgres } from '../support/postgres-container';
import { RedisFixture, startRedis } from '../support/redis-container';

jest.setTimeout(300_000);

const JWT_SECRET = 'integration-test-secret-0123456789abcdef';
const RATE_LIMIT_READ_PER_MINUTE = 600;
const RATE_LIMIT_WRITE_PER_MINUTE = 120;
const WRITE_SCOPE = 'capacity:write';
const SEEDED_PROGRAM_ID = 'b1b2c3d4-0001-4000-8000-000000000011';
const SEEDED_ORGANISATION_ID = 'a1b2c3d4-0001-4000-8000-000000000001';

const savedEnv = new Map<string, string | undefined>();

const setEnv = (key: string, value: string): void => {
  savedEnv.set(key, process.env[key]);
  process.env[key] = value;
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

interface ComponentSums {
  readonly local: bigint;
  readonly treasury: bigint;
  readonly limit: bigint;
}

interface PositionRow {
  readonly local_reserved_minor: string;
  readonly treasury_reserved_minor: string;
  readonly credit_limit_minor: string;
}

describe('ledger audit', () => {
  let postgres: PostgresFixture;
  let redis: RedisFixture;
  let owner: DataSource;
  let app: INestApplication;

  const token = sign(
    {
      org: SEEDED_ORGANISATION_ID,
      scope: WRITE_SCOPE,
      exp: nowSeconds() + 24 * 60 * 60,
    },
    JWT_SECRET,
    { algorithm: 'HS256' },
  );

  const ledgerSums = async (programId: string): Promise<ComponentSums> => {
    const rows = await owner.query<
      { component: string; total: string }[]
    >(
      `SELECT component, COALESCE(SUM(delta_minor), 0)::text AS total
         FROM capacity_ledger_entry
        WHERE program_id = $1
        GROUP BY component`,
      [programId],
    );

    const sums = { local: 0n, treasury: 0n, limit: 0n };
    for (const row of rows) {
      if (row.component === 'LOCAL') {
        sums.local = BigInt(row.total);
      } else if (row.component === 'TREASURY') {
        sums.treasury = BigInt(row.total);
      } else if (row.component === 'LIMIT') {
        sums.limit = BigInt(row.total);
      }
    }
    return sums;
  };

  const cachedPosition = async (programId: string): Promise<PositionRow> => {
    const rows = await owner.query<PositionRow[]>(
      `SELECT local_reserved_minor, treasury_reserved_minor, credit_limit_minor
         FROM program
        WHERE id = $1`,
      [programId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error('expected the program row to exist');
    }
    return row;
  };

  // SC-004b / FR-019a: every reported component equals the sum of its ledger
  // entries, so an auditor with only the ledger reproduces the position.
  const expectLedgerReconciles = async (programId: string): Promise<void> => {
    const sums = await ledgerSums(programId);
    const cached = await cachedPosition(programId);

    expect(sums.local).toBe(BigInt(cached.local_reserved_minor));
    expect(sums.treasury).toBe(BigInt(cached.treasury_reserved_minor));
    expect(sums.limit).toBe(BigInt(cached.credit_limit_minor));
  };

  beforeAll(async () => {
    postgres = await startPostgres();
    redis = await startRedis();

    setEnv('MIGRATION_DATABASE_URL', postgres.ownerUrl);
    setEnv('DATABASE_URL', postgres.ownerUrl);
    setEnv('REDIS_URL', redis.url);
    setEnv('KAFKA_BROKERS', 'localhost:9093');
    setEnv('KAFKA_SASL_USERNAME', 'capacity');
    setEnv('KAFKA_SASL_PASSWORD', 'capacity_local_dev');
    setEnv('JWT_SECRET', JWT_SECRET);
    setEnv('RATE_LIMIT_READ_PER_MINUTE', String(RATE_LIMIT_READ_PER_MINUTE));
    setEnv('RATE_LIMIT_WRITE_PER_MINUTE', String(RATE_LIMIT_WRITE_PER_MINUTE));

    const { dataSourceOptions } = await import('../../src/config/data-source');
    owner = new DataSource({
      ...dataSourceOptions,
      url: postgres.ownerUrl,
      entities: [],
    });
    await owner.initialize();
    await owner.runMigrations();

    setEnv('DATABASE_URL', postgres.appUrl);

    // `postgres-container` imported `data-source` before the environment was
    // set, so its captured `url` is undefined. Point that same options object at
    // the app role before the seed imports it, so the seed runs as the service
    // with the seed's own production code path.
    dataSourceOptions.url = postgres.appUrl;
    const { runSeed } = await import('../../scripts/seed');
    await runSeed();

    const { AppModule } = await import('../../src/app.module');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    await app.listen(0);
  });

  afterAll(async () => {
    if (app !== undefined) {
      await app.close();
    }
    if (owner?.isInitialized) {
      await owner.destroy();
    }
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await redis?.stop();
    await postgres?.stop();
  });

  it('reconciles every component for a program whose limit was set at seed time', async () => {
    const sums = await ledgerSums(SEEDED_PROGRAM_ID);

    // The opening credit limit must itself be a LIMIT ledger entry. If it were
    // written straight to the column, this sum would be zero for a program that
    // reports a non-zero limit — a defect in the phase 2 migration or seed.
    expect(sums.limit).toBeGreaterThan(0n);
    await expectLedgerReconciles(SEEDED_PROGRAM_ID);
  });

  it('reconciles all three components after a reserve and a partial release', async () => {
    const agent = request.agent(app.getHttpServer());
    const bearer = `Bearer ${token}`;
    const invoiceId = 'ledger-audit-invoice-1';

    const reserved = await agent
      .post(`/v1/programs/${SEEDED_PROGRAM_ID}/reservations`)
      .set('Authorization', bearer)
      .set('Idempotency-Key', 'ledger-audit-reserve-1')
      .send({
        invoiceId,
        amount: { amountMinor: '100000', currency: 'USD' },
      });
    expect(reserved.status).toBe(201);

    const released = await agent
      .post(`/v1/programs/${SEEDED_PROGRAM_ID}/reservations/${invoiceId}/releases`)
      .set('Authorization', bearer)
      .set('Idempotency-Key', 'ledger-audit-release-1')
      .send({ amount: { amountMinor: '40000', currency: 'USD' } });
    expect(released.status).toBe(201);

    await expectLedgerReconciles(SEEDED_PROGRAM_ID);
  });
});
