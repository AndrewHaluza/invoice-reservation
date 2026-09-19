import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  Controller,
  Get,
  Global,
  INestApplication,
  Module,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { SkipThrottle, ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { sign } from 'jsonwebtoken';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AuthModule } from '../../src/auth/auth.module';
import { RequiredScope } from '../../src/auth/required-scope.decorator';
import { RedisFixture, startRedis } from '../support/redis-container';

jest.setTimeout(180_000);

const JWT_SECRET = 'integration-test-secret-0123456789abcdef';
const CLOCK_SKEW_SECONDS = 60;
const LIMIT = 3;

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
      return LIMIT;
    }
    if (key === 'RATE_LIMIT_WRITE_PER_MINUTE') {
      return LIMIT;
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
      return LIMIT;
    }
    if (key === 'RATE_LIMIT_WRITE_PER_MINUTE') {
      return LIMIT;
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

@Global()
@Module({
  providers: [
    {
      provide: DataSource,
      useValue: { query: async (): Promise<unknown[]> => [] },
    },
  ],
  exports: [DataSource],
})
class TestDataSourceModule {}

@Controller()
class RateLimitProbeController {
  @Get('read')
  @RequiredScope('capacity:read')
  @SkipThrottle({ write: true })
  read(): { ok: boolean } {
    return { ok: true };
  }

  @Post('write')
  @RequiredScope('capacity:write')
  @SkipThrottle({ read: true })
  write(): { ok: boolean } {
    return { ok: true };
  }
}

describe('per-organisation rate limiting', () => {
  let redis: RedisFixture;
  let app: INestApplication;

  const nowSeconds = (): number => Math.floor(Date.now() / 1000);

  const token = (org: string, scope: string, jti: string): string =>
    sign(
      { org, scope, jti, exp: nowSeconds() + 3600 },
      JWT_SECRET,
      { algorithm: 'HS256' },
    );

  const get = (org: string, jti: string, scope = 'capacity:read') =>
    request(app.getHttpServer())
      .get('/read')
      .set('Authorization', `Bearer ${token(org, scope, jti)}`);

  const post = (org: string, jti: string, scope = 'capacity:write') =>
    request(app.getHttpServer())
      .post('/write')
      .set('Authorization', `Bearer ${token(org, scope, jti)}`);

  beforeAll(async () => {
    redis = await startRedis();
    redisUrl = redis.url;

    const moduleRef = await Test.createTestingModule({
      imports: [TestConfigModule, TestDataSourceModule, AuthModule],
      controllers: [RateLimitProbeController],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app !== undefined) {
      const storage = app.get(
        ThrottlerStorage,
      ) as ThrottlerStorageRedisService;
      await app.close();
      storage.redis.disconnect();
    }
    await redis?.stop();
  });

  it('answers 200 for the first three requests from one organisation', async () => {
    const org = randomUUID();
    const jti = randomUUID();

    for (let i = 0; i < LIMIT; i += 1) {
      const allowed = await get(org, jti);
      expect(allowed.status).toBe(200);
    }
  });

  it('answers 429 with RATE_LIMITED and Retry-After on the fourth request', async () => {
    const org = randomUUID();
    const jti = randomUUID();

    for (let i = 0; i < LIMIT; i += 1) {
      await get(org, jti);
    }

    const blocked = await get(org, jti);
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    expect(blocked.body.message).toBe(
      'Request budget exceeded for this organisation.',
    );

    const retryAfter = Number(blocked.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(Number.isInteger(retryAfter)).toBe(true);
  });

  it('keeps two different organisations in independent buckets', async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const jtiA = randomUUID();

    for (let i = 0; i < LIMIT; i += 1) {
      const allowed = await get(orgA, jtiA);
      expect(allowed.status).toBe(200);
    }

    const exhausted = await get(orgA, jtiA);
    expect(exhausted.status).toBe(429);

    const otherOrganisation = await get(orgB, randomUUID());
    expect(otherOrganisation.status).toBe(200);
  });

  it('shares one bucket across two tokens of the same organisation', async () => {
    const org = randomUUID();
    const firstToken = randomUUID();

    for (let i = 0; i < LIMIT; i += 1) {
      const allowed = await get(org, firstToken);
      expect(allowed.status).toBe(200);
    }

    const secondToken = await get(org, randomUUID());
    expect(secondToken.status).toBe(429);
    expect(secondToken.body.code).toBe('RATE_LIMITED');
  });

  it('keeps the read and write buckets separate', async () => {
    const org = randomUUID();
    const jti = randomUUID();

    for (let i = 0; i < LIMIT; i += 1) {
      const written = await post(org, jti);
      expect(written.status).toBe(201);
    }

    const blockedWrite = await post(org, jti);
    expect(blockedWrite.status).toBe(429);
    expect(blockedWrite.body.code).toBe('RATE_LIMITED');

    const readStillAllowed = await get(org, jti);
    expect(readStillAllowed.status).toBe(200);
  });
});
