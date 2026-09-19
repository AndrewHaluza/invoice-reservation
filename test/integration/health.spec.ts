import 'reflect-metadata';
import { Global, INestApplication, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { AuthModule } from '../../src/auth/auth.module';
import { dataSourceOptions } from '../../src/config/data-source';
import { HealthModule } from '../../src/observability';
import { PostgresFixture, startPostgres } from '../support/postgres-container';
import { RedisFixture, startRedis } from '../support/redis-container';

jest.setTimeout(180_000);

const JWT_SECRET = 'integration-test-secret-0123456789abcdef';
const CLOCK_SKEW_SECONDS = 60;
const RATE_LIMIT_READ_PER_MINUTE = 600;
const RATE_LIMIT_WRITE_PER_MINUTE = 120;

let redisUrl = '';

const configStub = {
  get: (key: string): unknown => {
    if (key === 'JWT_SECRET') {
      return JWT_SECRET;
    }
    if (key === 'JWT_CLOCK_SKEW_SECONDS') {
      return CLOCK_SKEW_SECONDS;
    }
    if (key === 'REDIS_URL') {
      return redisUrl;
    }
    if (key === 'RATE_LIMIT_READ_PER_MINUTE') {
      return RATE_LIMIT_READ_PER_MINUTE;
    }
    if (key === 'RATE_LIMIT_WRITE_PER_MINUTE') {
      return RATE_LIMIT_WRITE_PER_MINUTE;
    }
    return undefined;
  },
  getOrThrow: (key: string): unknown => {
    if (key === 'JWT_SECRET') {
      return JWT_SECRET;
    }
    if (key === 'JWT_CLOCK_SKEW_SECONDS') {
      return CLOCK_SKEW_SECONDS;
    }
    if (key === 'REDIS_URL') {
      return redisUrl;
    }
    if (key === 'RATE_LIMIT_READ_PER_MINUTE') {
      return RATE_LIMIT_READ_PER_MINUTE;
    }
    if (key === 'RATE_LIMIT_WRITE_PER_MINUTE') {
      return RATE_LIMIT_WRITE_PER_MINUTE;
    }
    throw new Error(`Missing configuration key: ${key}`);
  },
};

@Global()
@Module({
  providers: [{ provide: ConfigService, useValue: configStub }],
  exports: [ConfigService],
})
class TestConfigModule {}

async function buildApp(databaseUrl: string): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      TestConfigModule,
      TypeOrmModule.forRoot({
        type: 'postgres',
        url: databaseUrl,
        entities: [],
        migrations: [],
        synchronize: false,
        logging: false,
        retryAttempts: 0,
      }),
      // The real guard chain, so @Public() is proven end to end.
      AuthModule,
      HealthModule,
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

async function closeApp(app: INestApplication): Promise<void> {
  const storage = app.get(ThrottlerStorage) as ThrottlerStorageRedisService;
  await app.close();
  storage.redis.disconnect();
}

const LEAKS = ['postgres', '5432', 'localhost', 'password'];

function expectNoLeaks(body: unknown): void {
  const serialised = JSON.stringify(body);
  for (const leak of LEAKS) {
    expect(serialised).not.toContain(leak);
  }
}

describe('health endpoints', () => {
  let fixture: PostgresFixture;
  let redis: RedisFixture;
  let owner: DataSource;

  beforeAll(async () => {
    fixture = await startPostgres();
    owner = new DataSource({
      ...dataSourceOptions,
      url: fixture.ownerUrl,
      entities: [],
    });
    await owner.initialize();
    await owner.runMigrations();

    redis = await startRedis();
    redisUrl = redis.url;
  });

  afterAll(async () => {
    if (owner?.isInitialized) {
      await owner.destroy();
    }
    await fixture?.stop();
    await redis?.stop();
  });

  describe('with the database reachable', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await buildApp(fixture.ownerUrl);
    });

    afterAll(async () => {
      await closeApp(app);
    });

    it('GET /health/live returns 200 with no token', async () => {
      const response = await request(app.getHttpServer()).get('/health/live');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ok' });
    });

    it('GET /health/ready returns 200 when the database is up', async () => {
      const response = await request(app.getHttpServer()).get('/health/ready');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
    });

    it('leaks nothing in the ready body', async () => {
      const response = await request(app.getHttpServer()).get('/health/ready');

      expect(response.status).toBe(200);
      expectNoLeaks(response.body);
    });
  });

  describe('with the database unreachable', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await buildApp(fixture.ownerUrl);
      // Closing the DataSource leaves the provider in place but makes its query
      // fail immediately, which yields a deterministic 503 with no connect retry.
      const dataSource = app.get<DataSource>(getDataSourceToken());
      await dataSource.destroy();
    });

    afterAll(async () => {
      await closeApp(app);
    });

    it('GET /health/ready returns 503 when the database is unreachable', async () => {
      const response = await request(app.getHttpServer()).get('/health/ready');

      expect(response.status).toBe(503);
      expect(response.body.status).toBe('degraded');
    });

    it('leaks nothing in the 503 body', async () => {
      const response = await request(app.getHttpServer()).get('/health/ready');

      expect(response.status).toBe(503);
      expectNoLeaks(response.body);
    });
  });
});
