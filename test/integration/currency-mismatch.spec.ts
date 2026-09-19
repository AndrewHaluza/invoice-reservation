import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { sign } from 'jsonwebtoken';
import request from 'supertest';
import { DataSource } from 'typeorm';
import {
  NORTHWIND_ORGANISATION_ID,
  NORTHWIND_USD_PROGRAM_ID,
} from '../../scripts/seed';
import { createValidationPipe } from '../../src/shared/validation/create-validation-pipe';
import { PostgresFixture, startPostgres } from '../support/postgres-container';
import { RedisFixture, startRedis } from '../support/redis-container';

jest.setTimeout(180_000);

const JWT_SECRET = 'integration-test-secret-0123456789abcdef';
const RATE_LIMIT_PER_MINUTE = 100_000;
const WRITE_SCOPE = 'capacity:write';
const CREDIT_LIMIT_MINOR = '1000000000';

const savedEnv = new Map<string, string | undefined>();

const setEnv = (key: string, value: string): void => {
  savedEnv.set(key, process.env[key]);
  process.env[key] = value;
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

const tokenFor = (organisationId: string, scope: string): string =>
  sign({ org: organisationId, scope, exp: nowSeconds() + 3600 }, JWT_SECRET, {
    algorithm: 'HS256',
  });

interface CountRow {
  count: number;
}

describe('currency mismatch: an unrated reservation applies nothing', () => {
  let postgres: PostgresFixture;
  let redis: RedisFixture;
  let owner: DataSource;
  let app: INestApplication;
  let token: string;

  const organisationId = NORTHWIND_ORGANISATION_ID;
  const programId = NORTHWIND_USD_PROGRAM_ID;

  const countRows = async (table: string): Promise<number> => {
    const rows = await owner.query<CountRow[]>(
      `SELECT COUNT(*)::int AS count FROM ${table}`,
    );
    return rows[0]?.count ?? -1;
  };

  const tableCounts = async (): Promise<Record<string, number>> => ({
    ledger: await countRows('capacity_ledger_entry'),
    reservations: await countRows('invoice_reservation'),
    requests: await countRows('request_record'),
  });

  const postReservation = (
    idempotencyKey: string,
    invoiceId: string,
    amountMinor: string,
    currency: string,
  ) =>
    request(app.getHttpServer())
      .post(`/v1/programs/${programId}/reservations`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({ invoiceId, amount: { amountMinor, currency } });

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
    setEnv('RATE_LIMIT_READ_PER_MINUTE', String(RATE_LIMIT_PER_MINUTE));
    setEnv('RATE_LIMIT_WRITE_PER_MINUTE', String(RATE_LIMIT_PER_MINUTE));

    const { dataSourceOptions } = await import('../../src/config/data-source');
    owner = new DataSource({
      ...dataSourceOptions,
      url: postgres.ownerUrl,
      entities: [],
    });
    await owner.initialize();
    await owner.runMigrations();

    await owner.query(`INSERT INTO organisation (id, name) VALUES ($1, $2)`, [
      organisationId,
      'Northwind Trading',
    ]);
    await owner.query(
      `INSERT INTO program (id, organisation_id, currency, credit_limit_minor)
       VALUES ($1, $2, 'USD', $3)`,
      [programId, organisationId, CREDIT_LIMIT_MINOR],
    );
    await owner.query(
      `INSERT INTO fx_rate (base_currency, quote_currency, effective_at, rate, source)
       VALUES ('EUR', 'USD', to_timestamp(0), '1.0850000000', 'seed')`,
    );

    setEnv('DATABASE_URL', postgres.appUrl);

    const { AppModule } = await import('../../src/app.module');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    await app.init();

    token = tokenFor(organisationId, WRITE_SCOPE);
  });

  afterAll(async () => {
    if (app !== undefined) {
      const storage = app.get(
        ThrottlerStorage,
      ) as ThrottlerStorageRedisService;
      await app.close();
      storage.redis.disconnect();
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

  it('refuses a GBP reservation against the USD program and applies nothing', async () => {
    const before = await tableCounts();

    const response = await postReservation(
      'currency-gbp-0001',
      'inv-gbp',
      '100000',
      'GBP',
    );

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('FX_RATE_UNAVAILABLE');
    expect(await tableCounts()).toEqual(before);
  });

  it('accepts a EUR reservation against the same program at the seeded rate', async () => {
    const response = await postReservation(
      'currency-eur-0001',
      'inv-eur',
      '100000000',
      'EUR',
    );

    expect(response.status).toBe(201);
    expect(response.body.reservation.fx.rate).toBe('1.0850000000');
  });

  it('does not select a GBP rate dated after now', async () => {
    await owner.query(
      `INSERT INTO fx_rate (base_currency, quote_currency, effective_at, rate, source)
       VALUES ('GBP', 'USD', $1, '1.2700000000', 'test')`,
      [new Date(Date.now() + 24 * 60 * 60 * 1000)],
    );

    const response = await postReservation(
      'currency-gbp-future-0001',
      'inv-gbp-future',
      '100000',
      'GBP',
    );

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('FX_RATE_UNAVAILABLE');
  });

  it('refuses a JPY reservation whose converted amount rounds to zero', async () => {
    await owner.query(
      `INSERT INTO fx_rate (base_currency, quote_currency, effective_at, rate, source)
       VALUES ('JPY', 'USD', to_timestamp(0), '0.0067', 'test')`,
    );

    const response = await postReservation(
      'currency-jpy-0001',
      'inv-jpy',
      '1',
      'JPY',
    );

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('AMOUNT_ROUNDS_TO_ZERO');
  });
});
