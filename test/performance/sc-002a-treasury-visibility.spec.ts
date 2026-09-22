import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { Kafka, logLevel, type Producer } from 'kafkajs';
import { sign } from 'jsonwebtoken';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createValidationPipe } from '../../src/shared/validation/create-validation-pipe';
import { PostgresFixture, startPostgres } from '../support/postgres-container';
import {
  RedpandaFixture,
  kafkaEnvFor,
  startRedpanda,
} from '../support/redpanda-container';
import { RedisFixture, startRedis } from '../support/redis-container';
import {
  capacityEventMessage,
  insertOrganisation,
  insertProgram,
} from '../support/treasury';

jest.setTimeout(600_000);

const JWT_SECRET = 'integration-test-secret-0123456789abcdef';
const READ_SCOPE = 'capacity:read';

// SC-002a: a treasury-originated change must be visible in an availability read
// within 5 seconds at the 99th percentile, including broker and consumer time.
// The event is published to the real topic and the read is polled over HTTP; the
// budget is not relaxed for broker latency.
const ITERATIONS = 25;
const EVENT_AMOUNT_MINOR = 1000n;
const CREDIT_LIMIT_MINOR = 1_000_000_000;
const VISIBILITY_BUDGET_MS = 5_000;
const POLL_INTERVAL_MS = 50;
const ITERATION_TIMEOUT_MS = 15_000;
const WARMUP_TIMEOUT_MS = 60_000;

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

interface AvailabilityReadBody {
  readonly reserved: {
    readonly treasury: { readonly amountMinor: string };
  };
  readonly treasury: {
    readonly appliedVersion: number;
    readonly effectiveAt: string | null;
    readonly lagSeconds: number | null;
  };
}

// SC-002a polls availability after every publish, so the production read budget
// would answer 429 long before the run finishes. The override belongs to the
// test harness only; the production guards stay registered.
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

describe('SC-002a treasury change visibility', () => {
  let postgres: PostgresFixture;
  let redis: RedisFixture;
  let redpanda: RedpandaFixture;
  let owner: DataSource;
  let app: INestApplication;
  let producer: Producer;

  let organisationId: string;
  let programId: string;
  let bearer: string;

  const savedEnv = new Map<string, string | undefined>();

  const setEnv = (key: string, value: string): void => {
    savedEnv.set(key, process.env[key]);
    process.env[key] = value;
  };

  const nowSeconds = (): number => Math.floor(Date.now() / 1000);

  const publish = async (versionNumber: number): Promise<void> => {
    await producer.send({
      topic: redpanda.eventsTopic,
      messages: [
        {
          key: programId,
          value: capacityEventMessage({
            programId,
            messageId: `sc-002a-msg-${versionNumber}`,
            version: versionNumber,
            effectiveAt: new Date(
              Date.UTC(2026, 0, 1, 0, 0, versionNumber),
            ).toISOString(),
            type: 'RESERVATION_BOOKED',
            amountMinor: EVENT_AMOUNT_MINOR.toString(),
            reservationReference: null,
          }).value,
        },
      ],
    });
  };

  beforeAll(async () => {
    postgres = await startPostgres();
    redis = await startRedis();
    redpanda = await startRedpanda();

    // The real consumer returns early when NODE_ENV is 'test', so the harness
    // must present itself as development for ingestion to run at all.
    setEnv('NODE_ENV', 'development');
    setEnv('MIGRATION_DATABASE_URL', postgres.ownerUrl);
    setEnv('DATABASE_URL', postgres.ownerUrl);
    setEnv('REDIS_URL', redis.url);
    setEnv('KAFKA_SASL_USERNAME', 'capacity');
    setEnv('KAFKA_SASL_PASSWORD', 'capacity_local_dev');
    setEnv('JWT_SECRET', JWT_SECRET);
    for (const [key, value] of Object.entries(kafkaEnvFor(redpanda))) {
      setEnv(key, value);
    }

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

    setEnv('DATABASE_URL', postgres.appUrl);

    // ConfigModule validates the environment at import time, so AppModule is
    // imported only after the fixture has set every variable it requires.
    const { AppModule } = await import('../../src/app.module');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ThrottlerStorage)
      .useValue(unlimitedThrottlerStorage)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    // `listen(0)` binds one stable listener: with `init()` only, supertest starts
    // and tears down the HTTP server per request, which races under load.
    await app.listen(0);

    producer = new Kafka({
      brokers: redpanda.brokers,
      ssl: false,
      logLevel: logLevel.ERROR,
    }).producer();
    await producer.connect();

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
    if (producer !== undefined) {
      await producer.disconnect();
    }
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
    await redpanda?.stop();
  });

  it('reflects every treasury event in an availability read within 5s at p99', async () => {
    const agent = request.agent(app.getHttpServer());
    const latencies: number[] = [];
    let finalBody: AvailabilityReadBody | undefined;

    const delay = (ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms));

    const readAvailability = async (
      context: string,
    ): Promise<AvailabilityReadBody> => {
      const read = await agent
        .get(`/v1/programs/${programId}/availability`)
        .set('Authorization', bearer);
      if (read.status !== 200) {
        throw new Error(`${context}: availability read answered ${read.status}`);
      }
      return read.body as AvailabilityReadBody;
    };

    const pollUntilTreasuryMinor = async (
      expected: bigint,
      startedAt: number,
      timeoutMs: number,
      context: string,
    ): Promise<AvailabilityReadBody> => {
      const deadline = startedAt + timeoutMs;
      let observed: bigint | null = null;

      for (;;) {
        const body = await readAvailability(context);
        observed = BigInt(body.reserved.treasury.amountMinor);
        if (observed >= expected) {
          return body;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `${context}: treasury component did not reach ` +
              `${expected.toString()} within ${timeoutMs}ms; last observed ` +
              `${observed.toString()}`,
          );
        }
        await delay(POLL_INTERVAL_MS);
      }
    };

    // The consumer group starts at the latest offset on its first join, so an
    // event published before the join is never seen. The warm-up is one event
    // at version 1, outside the timed window: it is republished (the same
    // messageId and version, so the duplicate is deduplicated) until the
    // treasury component reflects it, which proves the consumer has joined.
    const warmupDeadline = Date.now() + WARMUP_TIMEOUT_MS;
    for (;;) {
      await publish(1);
      const attemptDeadline = Date.now() + 2_000;
      let warmed = false;
      while (Date.now() < attemptDeadline) {
        const body = await readAvailability('warm-up');
        if (BigInt(body.reserved.treasury.amountMinor) >= EVENT_AMOUNT_MINOR) {
          warmed = true;
          break;
        }
        await delay(POLL_INTERVAL_MS);
      }
      if (warmed) {
        break;
      }
      if (Date.now() >= warmupDeadline) {
        throw new Error(
          'warm-up: treasury component never reflected the warm-up event; ' +
            'the consumer did not consume a published message',
        );
      }
    }

    for (let index = 0; index < ITERATIONS; index += 1) {
      const versionNumber = index + 2;
      const expectedTreasuryMinor = EVENT_AMOUNT_MINOR * BigInt(versionNumber);
      const startedAt = Date.now();

      await publish(versionNumber);
      finalBody = await pollUntilTreasuryMinor(
        expectedTreasuryMinor,
        startedAt,
        ITERATION_TIMEOUT_MS,
        `iteration ${index}`,
      );
      latencies.push(Date.now() - startedAt);
    }

    expect(latencies).toHaveLength(ITERATIONS);
    expect(
      latencies.every((sample) => Number.isFinite(sample) && sample > 0),
    ).toBe(true);

    // The last read is the end-to-end proof: the consumer has applied the
    // newest event, so the probe's newest observed effective time matches the
    // applied one and the lag is zero. Null means the probe observed nothing.
    if (finalBody === undefined) {
      throw new Error('no availability read was recorded');
    }
    expect(finalBody.treasury.lagSeconds).toBe(0);

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
