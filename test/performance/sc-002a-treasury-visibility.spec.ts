import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { sign } from 'jsonwebtoken';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createValidationPipe } from '../../src/shared/validation/create-validation-pipe';
import {
  CapacityEvent,
  StreamCoordinates,
} from '../../src/shared/treasury/capacity-event';
import { parseCapacityEvent } from '../../src/treasury/schemas/capacity-event.schema';
import { PostgresFixture, startPostgres } from '../support/postgres-container';
import { RedisFixture, startRedis } from '../support/redis-container';
import {
  buildTreasuryHarness,
  capacityEventMessage,
  insertOrganisation,
  insertProgram,
  TreasuryHarness,
} from '../support/treasury';

jest.setTimeout(300_000);

const JWT_SECRET = 'integration-test-secret-0123456789abcdef';
const TOPIC = 'treasury.capacity.events';
const READ_SCOPE = 'capacity:read';

// SC-002a: a treasury-originated change must be visible in an availability read
// within 5 seconds at the 99th percentile. Anything under the tens of
// milliseconds is the expected result for a local write; the bound guards against
// a regression that defers the projection rather than the measurement itself.
const ITERATIONS = 25;
const EVENT_AMOUNT_MINOR = 1000n;
const CREDIT_LIMIT_MINOR = 1_000_000_000;
const VISIBILITY_BUDGET_MS = 5_000;

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

describe('SC-002a treasury change visibility', () => {
  let postgres: PostgresFixture;
  let redis: RedisFixture;
  let owner: DataSource;
  let harness: TreasuryHarness;
  let app: INestApplication;

  let organisationId: string;
  let programId: string;
  let bearer: string;

  const savedEnv = new Map<string, string | undefined>();

  const setEnv = (key: string, value: string): void => {
    savedEnv.set(key, process.env[key]);
    process.env[key] = value;
  };

  const nowSeconds = (): number => Math.floor(Date.now() / 1000);

  const coordinates = (offset: string): StreamCoordinates => ({
    topic: TOPIC,
    partition: 0,
    offset,
  });

  const eventFor = (index: number): CapacityEvent => {
    const parsed = parseCapacityEvent(
      capacityEventMessage({
        programId,
        messageId: `sc-002a-msg-${index}`,
        version: index + 1,
        effectiveAt: new Date(
          Date.UTC(2026, 0, 1, 0, 0, index),
        ).toISOString(),
        type: 'RESERVATION_BOOKED',
        amountMinor: EVENT_AMOUNT_MINOR.toString(),
        reservationReference: null,
        topic: TOPIC,
        partition: 0,
        offset: String(index),
      }).value,
    );
    if (!parsed.ok) {
      throw new Error(`expected a valid capacity event: ${parsed.detail}`);
    }
    return parsed.event;
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

    const { dataSourceOptions } = await import('../../src/config/data-source');
    owner = new DataSource({
      ...dataSourceOptions,
      url: postgres.ownerUrl,
      entities: [],
    });
    await owner.initialize();
    await owner.runMigrations();

    organisationId = await insertOrganisation(owner, 'sc-002a-org');
    programId = await insertProgram(owner, organisationId, {
      currency: 'USD',
      creditLimitMinor: CREDIT_LIMIT_MINOR,
      treasuryVersion: 0,
    });

    harness = buildTreasuryHarness(owner);

    setEnv('DATABASE_URL', postgres.appUrl);

    // ConfigModule validates the environment at import time, so AppModule is
    // imported only after the fixture has set every variable it requires.
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

  it('reflects every treasury event in an availability read within 5s at p99', async () => {
    const agent = request.agent(app.getHttpServer());
    const latencies: number[] = [];

    for (let index = 0; index < ITERATIONS; index += 1) {
      const expectedTreasuryMinor = EVENT_AMOUNT_MINOR * BigInt(index + 1);
      const startedAt = Date.now();

      const outcome = await harness.applyService.apply(
        eventFor(index),
        coordinates(String(index)),
      );
      expect(outcome.kind).toBe('applied');

      const deadline = startedAt + 10_000;
      let observedTreasuryMinor: bigint | null = null;

      while (Date.now() <= deadline) {
        const read = await agent
          .get(`/v1/programs/${programId}/availability`)
          .set('Authorization', bearer);
        if (read.status !== 200) {
          throw new Error(
            `iteration ${index}: availability read answered ${read.status}`,
          );
        }
        observedTreasuryMinor = BigInt(
          read.body.reserved.treasury.amountMinor,
        );
        if (observedTreasuryMinor >= expectedTreasuryMinor) {
          latencies.push(Date.now() - startedAt);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      if (
        observedTreasuryMinor === null ||
        observedTreasuryMinor < expectedTreasuryMinor
      ) {
        throw new Error(
          `iteration ${index}: treasury component was ` +
            `${String(observedTreasuryMinor)} but the event made it ` +
            `${expectedTreasuryMinor.toString()}`,
        );
      }
    }

    expect(latencies).toHaveLength(ITERATIONS);
    const sorted = [...latencies].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p99 = percentile(sorted, 99);
    const max = sorted[sorted.length - 1];
    console.log(
      `[SC-002a] iterations=${sorted.length} p50=${p50}ms p99=${p99}ms ` +
        `max=${max ?? 0}ms budget=${VISIBILITY_BUDGET_MS}ms`,
    );
    expect(p99).toBeLessThanOrEqual(VISIBILITY_BUDGET_MS);
  });
});
