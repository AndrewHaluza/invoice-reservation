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
const WRITE_SCOPE = 'capacity:write';

// SC-003a: 95% of reservation requests contending on a single program complete in
// under two seconds at 50 concurrent writers, with no request failing due to
// contention alone. The limit admits every writer, so every response must be 201:
// a 500 or a deadlock/serialization failure is exactly what this forbids.
const WRITERS = 50;
const RESERVATION_MINOR = 100n;
const CREDIT_LIMIT_MINOR = 10_000_000;
const LATENCY_BUDGET_MS = 2_000;

// macOS caps the listen backlog at kern.ipc.somaxconn (128 by default), so an
// unbounded burst of simultaneous connects overflows the accept queue and
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

describe('SC-003a reservation contention at 50 concurrent writers', () => {
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

    organisationId = await insertOrganisation(owner, 'sc-003a-org');
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
        scope: WRITE_SCOPE,
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

  it('accepts every contending reservation with p95 under two seconds', async () => {
    const results = await Promise.all(
      Array.from({ length: WRITERS }, (_, index) => {
        const startedAt = Date.now();
        return request(app.getHttpServer())
          .post(`/v1/programs/${programId}/reservations`)
          .agent(pool)
          .set('Authorization', bearer)
          .set('Idempotency-Key', `sc-003a-key-${index}`)
          .send({
            invoiceId: `sc-003a-invoice-${index}`,
            amount: {
              amountMinor: RESERVATION_MINOR.toString(),
              currency: 'USD',
            },
          })
          .then((response) => ({
            status: response.status,
            elapsedMs: Date.now() - startedAt,
          }));
      }),
    );

    // Every status must be 201: a 500 or a deadlock/serialization failure is a
    // failure caused by contention alone, which SC-003a forbids.
    const statuses = [...new Set(results.map((result) => result.status))];
    expect(statuses).toEqual([201]);

    const latencies = results
      .map((result) => result.elapsedMs)
      .sort((a, b) => a - b);
    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const max = latencies[latencies.length - 1];
    console.log(
      `[SC-003a] writers=${WRITERS} p50=${p50}ms p95=${p95}ms ` +
        `max=${max ?? 0}ms budget=${LATENCY_BUDGET_MS}ms`,
    );
    expect(p95).toBeLessThanOrEqual(LATENCY_BUDGET_MS);

    const accepted = results.filter((result) => result.status === 201).length;
    const expectedLocalMinor = RESERVATION_MINOR * BigInt(accepted);

    const rows = await owner.query<{ local_reserved_minor: string }[]>(
      `SELECT local_reserved_minor::text AS local_reserved_minor
         FROM program WHERE id = $1`,
      [programId],
    );
    expect(rows[0]?.local_reserved_minor).toBe(expectedLocalMinor.toString());
  });
});
