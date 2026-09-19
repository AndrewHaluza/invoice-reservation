import 'reflect-metadata';
import { generateKeyPairSync } from 'node:crypto';
import {
  Controller,
  Get,
  Global,
  INestApplication,
  Module,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { sign } from 'jsonwebtoken';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { AuthModule } from '../../src/auth/auth.module';
import { Public } from '../../src/auth/public.decorator';
import { RequiredScope } from '../../src/auth/required-scope.decorator';
import { dataSourceOptions } from '../../src/config/data-source';
import { PostgresFixture, startPostgres } from '../support/postgres-container';
import { RedisFixture, startRedis } from '../support/redis-container';

jest.setTimeout(180_000);

const JWT_SECRET = 'integration-test-secret-0123456789abcdef';
const CLOCK_SKEW_SECONDS = 60;
const RATE_LIMIT_READ_PER_MINUTE = 600;
const RATE_LIMIT_WRITE_PER_MINUTE = 120;

let redisUrl = '';

@Controller()
class ProbeController {
  @Get('programs/:programId/probe')
  @RequiredScope('capacity:read')
  probe(): { ok: boolean } {
    return { ok: true };
  }

  @Get('probe/public')
  @Public()
  publicProbe(): { ok: boolean } {
    return { ok: true };
  }
}

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

describe('authentication and program-scope guard chain', () => {
  let fixture: PostgresFixture;
  let redis: RedisFixture;
  let owner: DataSource;
  let app: INestApplication;

  let organisationA: string;
  let organisationB: string;
  let programA: string;
  let programB: string;

  const nowSeconds = (): number => Math.floor(Date.now() / 1000);

  const futureExp = (): number => nowSeconds() + 3600;

  const hs256 = (claims: Record<string, unknown>): string =>
    sign(claims, JWT_SECRET, { algorithm: 'HS256' });

  const authorisation = (token: string): string => `Bearer ${token}`;

  const insertReturningId = async (
    sql: string,
    parameters: unknown[],
  ): Promise<string> => {
    const rows = await owner.query<{ id: string }[]>(sql, parameters);
    const id = rows[0]?.id;
    if (id === undefined) {
      throw new Error('expected the insert to return exactly one row');
    }
    return id;
  };

  const newOrganisation = (name: string): Promise<string> =>
    insertReturningId(
      `INSERT INTO organisation (name) VALUES ($1) RETURNING id`,
      [name],
    );

  const newProgram = (organisationId: string): Promise<string> =>
    insertReturningId(
      `INSERT INTO program
         (organisation_id, currency, credit_limit_minor, local_reserved_minor)
        VALUES ($1, $2, $3, $4)
        RETURNING id`,
      [organisationId, 'USD', 1000, 0],
    );

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

    organisationA = await newOrganisation('auth-org-a');
    organisationB = await newOrganisation('auth-org-b');
    programA = await newProgram(organisationA);
    programB = await newProgram(organisationB);

    const moduleRef = await Test.createTestingModule({
      imports: [
        TestConfigModule,
        TypeOrmModule.forRoot({
          type: 'postgres',
          url: fixture.ownerUrl,
          entities: [],
          migrations: [],
          synchronize: false,
          logging: false,
        }),
        AuthModule,
      ],
      controllers: [ProbeController],
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
    if (owner?.isInitialized) {
      await owner.destroy();
    }
    await fixture?.stop();
    await redis?.stop();
  });

  it("answers 404 before any scope check for another organisation's program", async () => {
    const token = hs256({
      org: organisationA,
      scope: 'capacity:write',
      exp: futureExp(),
    });

    const response = await request(app.getHttpServer())
      .get(`/programs/${programB}/probe`)
      .set('Authorization', authorisation(token));

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('answers 403 INSUFFICIENT_SCOPE on a correctly-owned program with the wrong scope', async () => {
    const token = hs256({
      org: organisationA,
      scope: 'capacity:write',
      exp: futureExp(),
    });

    const response = await request(app.getHttpServer())
      .get(`/programs/${programA}/probe`)
      .set('Authorization', authorisation(token));

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('answers 200 on a correctly-owned program with the right scope', async () => {
    const token = hs256({
      org: organisationA,
      scope: 'capacity:read',
      exp: futureExp(),
    });

    const response = await request(app.getHttpServer())
      .get(`/programs/${programA}/probe`)
      .set('Authorization', authorisation(token));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it('rejects an alg: none token', async () => {
    const header = Buffer.from(
      JSON.stringify({ alg: 'none', typ: 'JWT' }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        org: organisationA,
        scope: 'capacity:read',
        exp: futureExp(),
      }),
    ).toString('base64url');
    const token = `${header}.${payload}.`;

    const response = await request(app.getHttpServer())
      .get(`/programs/${programA}/probe`)
      .set('Authorization', authorisation(token));

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });

  it('rejects an RS256-signed token', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const token = sign(
      { org: organisationA, scope: 'capacity:read', exp: futureExp() },
      privateKey,
      { algorithm: 'RS256' },
    );

    const response = await request(app.getHttpServer())
      .get(`/programs/${programA}/probe`)
      .set('Authorization', authorisation(token));

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a token expired outside the 60-second skew', async () => {
    const token = hs256({
      org: organisationA,
      scope: 'capacity:read',
      exp: nowSeconds() - 120,
    });

    const response = await request(app.getHttpServer())
      .get(`/programs/${programA}/probe`)
      .set('Authorization', authorisation(token));

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });

  it('accepts a token that expired 30 seconds ago, proving the skew applies', async () => {
    const token = hs256({
      org: organisationA,
      scope: 'capacity:read',
      exp: nowSeconds() - 30,
    });

    const response = await request(app.getHttpServer())
      .get(`/programs/${programA}/probe`)
      .set('Authorization', authorisation(token));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it('rejects a token whose org claim is not a UUID', async () => {
    const token = hs256({
      org: 'not-a-uuid',
      scope: 'capacity:read',
      exp: futureExp(),
    });

    const response = await request(app.getHttpServer())
      .get(`/programs/${programA}/probe`)
      .set('Authorization', authorisation(token));

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a request with no Authorization header', async () => {
    const response = await request(app.getHttpServer()).get(
      `/programs/${programA}/probe`,
    );

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });

  it('serves a @Public() route with no token at all', async () => {
    const response = await request(app.getHttpServer()).get('/probe/public');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it('answers 404 for a malformed programId rather than a database 500', async () => {
    const token = hs256({
      org: organisationA,
      scope: 'capacity:read',
      exp: futureExp(),
    });

    const response = await request(app.getHttpServer())
      .get('/programs/not-a-uuid/probe')
      .set('Authorization', authorisation(token));

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('leaks nothing in the 404 body', async () => {
    const token = hs256({
      org: organisationA,
      scope: 'capacity:write',
      exp: futureExp(),
    });

    const response = await request(app.getHttpServer())
      .get(`/programs/${programB}/probe`)
      .set('Authorization', authorisation(token));

    expect(response.status).toBe(404);
    expect(response.body).not.toHaveProperty('stack');
    expect(response.body).not.toHaveProperty('sql');
    expect(response.body).not.toHaveProperty('query');
    expect(JSON.stringify(response.body)).not.toContain(programB);
  });
});
