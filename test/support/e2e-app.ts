import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { sign } from 'jsonwebtoken';
import { DataSource } from 'typeorm';
import { createValidationPipe } from '../../src/shared/validation/create-validation-pipe';
import { PostgresFixture, startPostgres } from './postgres-container';
import { RedisFixture, startRedis } from './redis-container';

export const JWT_SECRET = 'e2e-test-secret-0123456789abcdefghij';
export const WRITE_SCOPE = 'capacity:write';
export const READ_SCOPE = 'capacity:read';

export interface E2eApp {
  app: INestApplication;
  owner: DataSource; // the OWNER connection, for fixture setup and row reads
  postgres: PostgresFixture;
  redis: RedisFixture;
  savedEnv: Map<string, string | undefined>;
}

export function tokenFor(organisationId: string, scope: string): string {
  return sign(
    {
      org: organisationId,
      scope,
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    JWT_SECRET,
    { algorithm: 'HS256' },
  );
}

export async function startE2eApp(): Promise<E2eApp> {
  const savedEnv = new Map<string, string | undefined>();
  const setEnv = (key: string, value: string): void => {
    savedEnv.set(key, process.env[key]);
    process.env[key] = value;
  };

  const postgres = await startPostgres();
  const redis = await startRedis();

  setEnv('MIGRATION_DATABASE_URL', postgres.ownerUrl);
  setEnv('DATABASE_URL', postgres.ownerUrl);
  setEnv('REDIS_URL', redis.url);
  setEnv('KAFKA_BROKERS', 'localhost:9093');
  setEnv('KAFKA_LAG_PROBE_ENABLED', 'false');
  setEnv('KAFKA_SASL_USERNAME', 'capacity');
  setEnv('KAFKA_SASL_PASSWORD', 'capacity_local_dev');
  setEnv('JWT_SECRET', JWT_SECRET);
  setEnv('RATE_LIMIT_READ_PER_MINUTE', '600');
  setEnv('RATE_LIMIT_WRITE_PER_MINUTE', '120');

  const { dataSourceOptions } = await import('../../src/config/data-source');
  const owner = new DataSource({
    ...dataSourceOptions,
    url: postgres.ownerUrl,
    entities: [],
  });
  await owner.initialize();
  await owner.runMigrations();

  await owner.query(
    `INSERT INTO fx_rate (base_currency, quote_currency, effective_at, rate, source)
     VALUES ('EUR', 'USD', to_timestamp(0), '1.0850000000', 'seed'),
            ('USD', 'EUR', to_timestamp(0), '0.9216589862', 'seed')`,
  );

  // Switch DATABASE_URL to the non-owner app role before the application is
  // imported. `capacity_app` is not the table owner, so the ledger's
  // REVOKE UPDATE, DELETE actually binds. Leaving the owner URL in place lets
  // the application rewrite history, and the suite would then pass while
  // testing a permission model production does not have.
  setEnv('DATABASE_URL', postgres.appUrl);

  const { AppModule } = await import('../../src/app.module');
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(createValidationPipe());
  // `listen(0)` — not `init()`. With `init()` alone, supertest starts and tears
  // down the HTTP server around individual requests; under parallel load that
  // race surfaces as a raw, body-less 501/404 that never reached the Nest
  // pipeline — exactly the symptom User Story 3 exists to disprove.
  await app.listen(0);

  return { app, owner, postgres, redis, savedEnv };
}

export async function stopE2eApp(fixture: E2eApp | undefined): Promise<void> {
  if (fixture === undefined) {
    return;
  }

  if (fixture.app !== undefined) {
    let storage: ThrottlerStorageRedisService | undefined;
    try {
      storage = fixture.app.get(ThrottlerStorage) as ThrottlerStorageRedisService;
    } catch {
      storage = undefined;
    }
    try {
      await fixture.app.close();
    } catch {
      // A failure closing the app must not hide an earlier setup error.
    }
    try {
      storage?.redis.disconnect();
    } catch {
      // Closing the app alone leaves the Redis client open and Jest hangs.
    }
  }

  if (fixture.owner?.isInitialized) {
    try {
      await fixture.owner.destroy();
    } catch {
      // A failure destroying the owner connection must not cascade.
    }
  }

  for (const [key, value] of fixture.savedEnv ?? []) {
    try {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    } catch {
      // Restoring env is best-effort; never let it mask the original error.
    }
  }

  try {
    await fixture.redis?.stop();
  } catch {
    // A failed Redis stop must not prevent the Postgres container stopping.
  }
  try {
    await fixture.postgres?.stop();
  } catch {
    // The last teardown step must not throw.
  }
}
