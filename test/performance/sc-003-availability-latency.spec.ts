import 'reflect-metadata';
import { Agent } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { sign } from 'jsonwebtoken';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createValidationPipe } from '../../src/shared/validation/create-validation-pipe';
import { PostgresFixture, startPostgres } from '../support/postgres-container';
import { RedisFixture, startRedis } from '../support/redis-container';
import { insertOrganisation, insertProgram } from '../support/treasury';

jest.setTimeout(300_000);

const JWT_SECRET = 'integration-test-secret-0123456789abcdef';
const READ_SCOPE = 'capacity:read';

// SC-003: 95% of availability queries return in under one second at 200
// concurrent clients.
const CONCURRENCY = 200;
const CREDIT_LIMIT_MINOR = 1_000_000_000;
const LATENCY_BUDGET_MS = 1_000;

// macOS caps the listen backlog at kern.ipc.somaxconn (128 by default), so an
// unbounded burst of 200 simultaneous connects overflows the accept queue and
// surfaces as a transport failure rather than a service latency. A bounded
// keep-alive pool still launches every request at once while holding the number
// of open sockets below the backlog.
const MAX_SOCKETS = 100;

/** Nearest-rank percentile over an ascending-sorted sample. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    throw new Error('percentile requires at least one observation');
  }
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  const value = sorted[index];
  if (value === undefined) {
    throw new Error('percentile index fell outside the sample');
  }
  return value;
}

describe('SC-003 availability read latency at 200 concurrent clients', () => {
  let postgres: PostgresFixture;
  let redis: RedisFixture;
  let owner: DataSource;
  let app: INestApplication;
  let pool: Agent;

  let organisationId: string;
  let programId: string;
  let bearer: string;

  const savedEnv = new Map<string, string | undefined>();

  const setEnv = (key: string, value: string): void => {
    savedEnv.set(key, process.env[key]);
    process.env[key] = value;
  };

  const nowSeconds = (): number => Math.floor(Date.now() / 1000);

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

    const { dataSourceOptions } = await import('../../src/config/data-source');
    owner = new DataSource({
      ...dataSourceOptions,
      url: postgres.ownerUrl,
      entities: [],
    });
    await owner.initialize();
    await owner.runMigrations();

    organisationId = await insertOrganisation(owner, 'sc-003-org');
    programId = await insertProgram(owner, organisationId, {
      currency: 'USD',
      creditLimitMinor: CREDIT_LIMIT_MINOR,
    });

    setEnv('DATABASE_URL', postgres.appUrl);

    const { AppModule } = await import('../../src/app.module');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    // `listen(0)` binds one stable listener: with `init()` only, supertest starts
    // and tears down the HTTP server per request, which races under load.
    await app.listen(0);

    bearer = `Bearer ${sign(
      {
        org: organisationId,
        scope: READ_SCOPE,
        exp: nowSeconds() + 3600,
      },
      JWT_SECRET,
      { algorithm: 'HS256' },
    )}`;

    pool = new Agent({ keepAlive: true, maxSockets: MAX_SOCKETS });
  });

  afterAll(async () => {
    pool?.destroy();
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

  it('answers 200 for all 200 concurrent reads with p95 under one second', async () => {
    const pending = Promise.all(
      Array.from({ length: CONCURRENCY }, () => {
        const startedAt = Date.now();
        return request(app.getHttpServer())
          .get(`/v1/programs/${programId}/availability`)
          .agent(pool)
          .set('Authorization', bearer)
          .then((response) => ({
            status: response.status,
            elapsedMs: Date.now() - startedAt,
          }));
      }),
    );

    const results = await pending;

    const statuses = [...new Set(results.map((result) => result.status))];
    expect(statuses).toEqual([200]);

    const latencies = results
      .map((result) => result.elapsedMs)
      .sort((a, b) => a - b);
    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const max = latencies[latencies.length - 1];
    console.log(
      `[SC-003] clients=${CONCURRENCY} p50=${p50}ms p95=${p95}ms ` +
        `max=${max ?? 0}ms budget=${LATENCY_BUDGET_MS}ms`,
    );
    expect(p95).toBeLessThanOrEqual(LATENCY_BUDGET_MS);
  });
});
