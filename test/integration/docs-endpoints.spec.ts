import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { load } from 'js-yaml';
import { sign } from 'jsonwebtoken';
import request from 'supertest';
import { DataSource } from 'typeorm';
import {
  CONTOSO_USD_PROGRAM_ID,
  NORTHWIND_ORGANISATION_ID,
  NORTHWIND_USD_PROGRAM_ID,
  TOKEN_SCOPE,
} from '../../scripts/seed';
import { mountApiDocs } from '../../src/docs';
import { createValidationPipe } from '../../src/shared/validation/create-validation-pipe';
import { PostgresFixture, startPostgres } from '../support/postgres-container';
import { RedisFixture, startRedis } from '../support/redis-container';

jest.setTimeout(180_000);

const JWT_SECRET = 'integration-test-secret-0123456789abcdef';

const savedEnv = new Map<string, string | undefined>();

const setEnv = (key: string, value: string): void => {
  savedEnv.set(key, process.env[key]);
  process.env[key] = value;
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

const tokenFor = (organisationId: string, scope: string): string =>
  sign(
    { org: organisationId, scope, exp: nowSeconds() + 3600 },
    JWT_SECRET,
    { algorithm: 'HS256' },
  );

// The router's catch-all replies with a body whose `message` echoes the requested
// path (`Cannot GET <path>`; see @nestjs/core's routes-resolver) and a fresh
// `correlationId`. Both are per-request facts shared by every unknown path, so
// neither is a documentation-surface difference. Normalise them away: drop the
// `correlationId` and collapse the echoed path to a fixed placeholder. Anything
// still unequal is a real difference between the disabled docs routes and an
// arbitrary unknown path — which is the non-disclosure property under test.
const normaliseNotFound = (
  body: Record<string, unknown>,
  requestedPath: string,
): Record<string, unknown> => {
  const copy = { ...body };
  delete copy.correlationId;
  if (typeof copy.message === 'string') {
    copy.message = copy.message.split(requestedPath).join('<path>');
  }
  return copy;
};

const disconnectStorage = async (app: INestApplication): Promise<void> => {
  const storage = app.get(ThrottlerStorage) as ThrottlerStorageRedisService;
  await app.close();
  storage.redis.disconnect();
};

describe('served API documentation', () => {
  let postgres: PostgresFixture;
  let redis: RedisFixture;
  let owner: DataSource;
  let enabledApp: INestApplication;
  let disabledApp: INestApplication;

  beforeAll(async () => {
    postgres = await startPostgres();
    redis = await startRedis();

    setEnv('MIGRATION_DATABASE_URL', postgres.ownerUrl);
    setEnv('DATABASE_URL', postgres.ownerUrl);
    setEnv('REDIS_URL', redis.url);
    setEnv('KAFKA_BROKERS', 'localhost:9093');
    setEnv('KAFKA_LAG_PROBE_ENABLED', 'false');
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

    setEnv('DATABASE_URL', postgres.appUrl);

    const { AppModule } = await import('../../src/app.module');

    const enabledModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    enabledApp = enabledModule.createNestApplication();
    enabledApp.useGlobalPipes(createValidationPipe());
    mountApiDocs(enabledApp, { enabled: true, port: 4010, version: '0.1.0' });
    await enabledApp.init();

    const disabledModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    disabledApp = disabledModule.createNestApplication();
    disabledApp.useGlobalPipes(createValidationPipe());
    mountApiDocs(disabledApp, { enabled: false, port: 4010, version: '0.1.0' });
    await disabledApp.init();
  });

  afterAll(async () => {
    if (enabledApp !== undefined) {
      await disconnectStorage(enabledApp);
    }
    if (disabledApp !== undefined) {
      await disconnectStorage(disabledApp);
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

  describe('enabled', () => {
    it('serves the Swagger UI at /docs', async () => {
      const response = await request(enabledApp.getHttpServer()).get('/docs');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.text.toLowerCase()).toContain('swagger');
    });

    it('serves the OpenAPI 3.1 JSON document', async () => {
      const response = await request(enabledApp.getHttpServer()).get(
        '/docs/openapi.json',
      );

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.body.openapi).toBe('3.1.0');
    });

    it('serves the OpenAPI document as YAML matching the JSON document', async () => {
      const yamlResponse = await request(enabledApp.getHttpServer()).get(
        '/docs/openapi.yaml',
      );
      const jsonResponse = await request(enabledApp.getHttpServer()).get(
        '/docs/openapi.json',
      );

      expect(yamlResponse.status).toBe(200);
      expect(yamlResponse.headers['content-type']).toContain('yaml');
      expect(load(yamlResponse.text)).toEqual(jsonResponse.body);
    });

    it('still refuses an unauthenticated API call with 401', async () => {
      const response = await request(enabledApp.getHttpServer()).get(
        `/v1/programs/${NORTHWIND_USD_PROGRAM_ID}/availability`,
      );

      expect(response.status).toBe(401);
    });

    it('accepts a valid Northwind token against the Northwind program', async () => {
      const token = tokenFor(NORTHWIND_ORGANISATION_ID, TOKEN_SCOPE);

      const response = await request(enabledApp.getHttpServer())
        .get(`/v1/programs/${NORTHWIND_USD_PROGRAM_ID}/availability`)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).not.toBe(401);
    });

    it("answers 404 NOT_FOUND, never 403, for another organisation's program", async () => {
      const token = tokenFor(NORTHWIND_ORGANISATION_ID, TOKEN_SCOPE);

      const response = await request(enabledApp.getHttpServer())
        .get(`/v1/programs/${CONTOSO_USD_PROGRAM_ID}/availability`)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('NOT_FOUND');
    });
  });

  describe('disabled', () => {
    it('does not serve /docs', async () => {
      const response = await request(disabledApp.getHttpServer()).get('/docs');

      expect(response.status).toBe(404);
    });

    it('does not serve /docs/openapi.json', async () => {
      const response = await request(disabledApp.getHttpServer()).get(
        '/docs/openapi.json',
      );

      expect(response.status).toBe(404);
    });

    it('is indistinguishable from any unknown path', async () => {
      const docs = await request(disabledApp.getHttpServer()).get('/docs');
      const json = await request(disabledApp.getHttpServer()).get(
        '/docs/openapi.json',
      );
      const unknown = await request(disabledApp.getHttpServer()).get(
        '/nonexistent-path-for-comparison',
      );

      expect(docs.status).toBe(404);
      expect(json.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(docs.body.code).toBe('NOT_FOUND');
      expect(json.body.code).toBe('NOT_FOUND');
      expect(unknown.body.code).toBe('NOT_FOUND');

      expect(normaliseNotFound(docs.body, '/docs')).toEqual(
        normaliseNotFound(json.body, '/docs/openapi.json'),
      );
      expect(normaliseNotFound(json.body, '/docs/openapi.json')).toEqual(
        normaliseNotFound(
          unknown.body,
          '/nonexistent-path-for-comparison',
        ),
      );
    });

    it('leaves the rest of the API unaffected', async () => {
      const response = await request(disabledApp.getHttpServer()).get(
        '/health/live',
      );

      expect(response.status).toBe(200);
    });
  });
});
