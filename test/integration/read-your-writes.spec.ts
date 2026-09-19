import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { sign } from 'jsonwebtoken';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createValidationPipe } from '../../src/shared/validation/create-validation-pipe';
import { PostgresFixture, startPostgres } from '../support/postgres-container';
import { RedisFixture, startRedis } from '../support/redis-container';

// SC-002 runs 10,000 reserve-then-read trials. The registered write budget is
// 120/min, so the production guard chain would answer 429 long before the run
// finishes — the throttle, not the position, would be what breaks it. The
// override below belongs to the test harness only; the production guards stay
// registered.
jest.setTimeout(3_600_000);

const JWT_SECRET = 'integration-test-secret-0123456789abcdef';
const RATE_LIMIT_READ_PER_MINUTE = 600;
const RATE_LIMIT_WRITE_PER_MINUTE = 120;
const READ_WRITE_SCOPE = 'capacity:read capacity:write';
const TRIALS = 10_000;
// One minor unit per trial, so 10,000 trials reserve 10,000 units in total and
// the program cannot be driven over its limit by the run itself.
const CREDIT_LIMIT_MINOR = 1_000_000n;

const savedEnv = new Map<string, string | undefined>();

const setEnv = (key: string, value: string): void => {
  savedEnv.set(key, process.env[key]);
  process.env[key] = value;
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

const unlimitedThrottlerStorage = {
  increment: (): Promise<{
    totalHits: number;
    timeToExpire: number;
    isBlocked: boolean;
    timeToBlockExpire: number;
  }> =>
    Promise.resolve({
      totalHits: 1,
      timeToExpire: 60_000,
      isBlocked: false,
      timeToBlockExpire: 0,
    }),
};

describe('read your writes', () => {
  let postgres: PostgresFixture;
  let redis: RedisFixture;
  let owner: DataSource;
  let app: INestApplication;

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

    // AppModule's ConfigModule validates the environment at import time, so it
    // is imported only after the fixture has set every variable it requires.
    const { AppModule } = await import('../../src/app.module');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ThrottlerStorage)
      .useValue(unlimitedThrottlerStorage)
      .compile();

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

  it("reflects the caller's own accepted reservation in the very next availability read, 10,000 times (SC-002)", async () => {
    const organisationRows = await owner.query<{ id: string }[]>(
      `INSERT INTO organisation (name) VALUES ($1) RETURNING id`,
      ['read-your-writes'],
    );
    const organisationId = organisationRows[0]?.id;
    if (organisationId === undefined) {
      throw new Error('expected the organisation insert to return one row');
    }

    const programRows = await owner.query<{ id: string }[]>(
      `INSERT INTO program (organisation_id, currency, credit_limit_minor)
       VALUES ($1, 'USD', $2)
       RETURNING id`,
      [organisationId, CREDIT_LIMIT_MINOR.toString()],
    );
    const programId = programRows[0]?.id;
    if (programId === undefined) {
      throw new Error('expected the program insert to return one row');
    }

    const token = sign(
      {
        org: organisationId,
        scope: READ_WRITE_SCOPE,
        exp: nowSeconds() + 24 * 60 * 60,
      },
      JWT_SECRET,
      { algorithm: 'HS256' },
    );
    const bearer = `Bearer ${token}`;
    const agent = request.agent(app.getHttpServer());

    let failure: string | null = null;

    for (let trial = 0; trial < TRIALS && failure === null; trial += 1) {
      const reserved = await agent
        .post(`/v1/programs/${programId}/reservations`)
        .set('Authorization', bearer)
        .set('Idempotency-Key', `read-your-writes-key-${trial}`)
        .send({
          invoiceId: `read-your-writes-invoice-${trial}`,
          amount: { amountMinor: '1', currency: 'USD' },
        });

      if (reserved.status !== 201) {
        failure = `trial ${trial}: reserve answered ${reserved.status}`;
        break;
      }

      const read = await agent
        .get(`/v1/programs/${programId}/availability`)
        .set('Authorization', bearer);

      if (read.status !== 200) {
        failure = `trial ${trial}: availability read answered ${read.status}`;
        break;
      }

      const expectedReserved = String(trial + 1);
      const expectedAvailable = String(CREDIT_LIMIT_MINOR - BigInt(trial + 1));

      if (read.body?.reserved?.local?.amountMinor !== expectedReserved) {
        failure =
          `trial ${trial}: reserved.local was ` +
          `${String(read.body?.reserved?.local?.amountMinor)} but the caller's ` +
          `own accepted change made it ${expectedReserved}`;
        break;
      }

      if (read.body?.available?.amountMinor !== expectedAvailable) {
        failure =
          `trial ${trial}: available was ` +
          `${String(read.body?.available?.amountMinor)} but the exact reserved ` +
          `amount made it ${expectedAvailable}`;
        break;
      }
    }

    if (failure !== null) {
      throw new Error(failure);
    }
  });
});
