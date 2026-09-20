import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { sign } from 'jsonwebtoken';
import request from 'supertest';
import { DataSource } from 'typeorm';
import {
  CONTOSO_ORGANISATION_ID,
  CONTOSO_USD_PROGRAM_ID,
  NORTHWIND_ORGANISATION_ID,
} from '../../scripts/seed';
import { createValidationPipe } from '../../src/shared/validation/create-validation-pipe';
import { openapiValidator } from '../support/openapi';
import { PostgresFixture, startPostgres } from '../support/postgres-container';
import { RedisFixture, startRedis } from '../support/redis-container';

jest.setTimeout(180_000);

const JWT_SECRET = 'integration-test-secret-0123456789abcdef';
const RATE_LIMIT_READ_PER_MINUTE = 600;
const RATE_LIMIT_WRITE_PER_MINUTE = 120;
const WRITE_SCOPE = 'capacity:write';

const RESERVATION_RESPONSE_REF = '#/components/schemas/ReservationResponse';
const ERROR_REF = '#/components/schemas/Error';

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

const authorisation = (token: string): string => `Bearer ${token}`;

function expectValidAgainst(schemaRef: string, body: unknown): void {
  const validate = openapiValidator(schemaRef);
  const valid = validate(body);
  if (!valid) {
    throw new Error(
      `Body does not validate against ${schemaRef}: ${JSON.stringify(
        validate.errors,
        null,
        2,
      )}`,
    );
  }
}

function expectNoInternalKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      expectNoInternalKeys(entry);
    }
    return;
  }
  if (value === null || typeof value !== 'object') {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    expect(['stack', 'sql', 'query']).not.toContain(key);
    expectNoInternalKeys(child);
  }
}

describe('reservation contract', () => {
  let postgres: PostgresFixture;
  let redis: RedisFixture;
  let owner: DataSource;
  let app: INestApplication;

  const createOrganisation = async (name: string): Promise<string> => {
    const rows = await owner.query<{ id: string }[]>(
      `INSERT INTO organisation (name) VALUES ($1) RETURNING id`,
      [name],
    );
    const id = rows[0]?.id;
    if (id === undefined) {
      throw new Error('expected the organisation insert to return one row');
    }
    return id;
  };

  const createProgram = async (
    organisationId: string,
    creditLimitMinor: bigint,
  ): Promise<string> => {
    const rows = await owner.query<{ id: string }[]>(
      `INSERT INTO program (organisation_id, currency, credit_limit_minor)
       VALUES ($1, 'USD', $2)
       RETURNING id`,
      [organisationId, creditLimitMinor.toString()],
    );
    const id = rows[0]?.id;
    if (id === undefined) {
      throw new Error('expected the program insert to return one row');
    }
    return id;
  };

  const post = (
    programId: string,
    token: string,
    idempotencyKey: string | undefined,
    body: object,
  ) => {
    const pending = request(app.getHttpServer())
      .post(`/v1/programs/${programId}/reservations`)
      .set('Authorization', authorisation(token));
    if (idempotencyKey !== undefined) {
      pending.set('Idempotency-Key', idempotencyKey);
    }
    return pending.send(body);
  };

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

    await owner.query(
      `INSERT INTO organisation (id, name)
       VALUES ($1, $2), ($3, $4)`,
      [
        NORTHWIND_ORGANISATION_ID,
        'Northwind Trading',
        CONTOSO_ORGANISATION_ID,
        'Contoso Finance',
      ],
    );
    await owner.query(
      `INSERT INTO program (id, organisation_id, currency, credit_limit_minor)
       VALUES ($1, $2, 'USD', $3), ($4, $5, 'USD', $6)`,
      [
        'b1b2c3d4-0001-4000-8000-000000000011',
        NORTHWIND_ORGANISATION_ID,
        '1000000000',
        CONTOSO_USD_PROGRAM_ID,
        CONTOSO_ORGANISATION_ID,
        '200000000',
      ],
    );
    await owner.query(
      `INSERT INTO fx_rate (base_currency, quote_currency, effective_at, rate, source)
       VALUES ('EUR', 'USD', to_timestamp(0), '1.0850000000', 'seed'),
              ('USD', 'EUR', to_timestamp(0), '0.9216589862', 'seed')`,
    );

    setEnv('DATABASE_URL', postgres.appUrl);

    const { AppModule } = await import('../../src/app.module');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    // Bind the listener once. With `init()` only, supertest starts (and tears
    // down) the HTTP server around individual requests; under parallel load
    // that race surfaces as a raw, body-less HTTP response (501/404) that never
    // reached the Nest pipeline. `listen(0)` gives every request one stable
    // listener, as the concurrency suite already does.
    await app.listen(0);
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

  it('201 validates against ReservationResponse and amountMinor crosses the wire as a string', async () => {
    const organisationId = await createOrganisation('contract-201');
    const programId = await createProgram(organisationId, 1_000_000_000n);

    const response = await post(
      programId,
      tokenFor(organisationId, WRITE_SCOPE),
      'contract-201-key',
      {
        invoiceId: 'contract-inv-201',
        amount: { amountMinor: '100000', currency: 'USD' },
      },
    );

    expect(response.status).toBe(201);
    expectValidAgainst(RESERVATION_RESPONSE_REF, response.body);
    expect(typeof response.body.reservation.reserved.amountMinor).toBe('string');
    expect(response.text).toContain('"amountMinor":"');
  });

  it('200 replay validates against ReservationResponse', async () => {
    const organisationId = await createOrganisation('contract-200');
    const programId = await createProgram(organisationId, 1_000_000_000n);
    const token = tokenFor(organisationId, WRITE_SCOPE);
    const body = {
      invoiceId: 'contract-inv-200',
      amount: { amountMinor: '250000', currency: 'USD' },
    };

    const first = await post(programId, token, 'contract-200-key', body);
    const second = await post(programId, token, 'contract-200-key', body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expectValidAgainst(RESERVATION_RESPONSE_REF, second.body);
    expect(second.body).toEqual(first.body);
  });

  it('409 validates against Error', async () => {
    const organisationId = await createOrganisation('contract-409');
    const programId = await createProgram(organisationId, 1_000_000_000n);
    const token = tokenFor(organisationId, WRITE_SCOPE);

    const first = await post(programId, token, 'contract-409-key', {
      invoiceId: 'contract-inv-409',
      amount: { amountMinor: '100000', currency: 'USD' },
    });
    expect(first.status).toBe(201);

    const conflict = await post(programId, token, 'contract-409-key', {
      invoiceId: 'contract-inv-409',
      amount: { amountMinor: '200000', currency: 'USD' },
    });

    expect(conflict.status).toBe(409);
    expectValidAgainst(ERROR_REF, conflict.body);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
    expectNoInternalKeys(conflict.body);
  });

  it('the missing Idempotency-Key 400 validates against the Error schema', async () => {
    const organisationId = await createOrganisation('contract-missing-key');
    const programId = await createProgram(organisationId, 1_000_000_000n);
    const token = tokenFor(organisationId, WRITE_SCOPE);

    const response = await post(programId, token, undefined, {
      invoiceId: 'contract-inv-missing-key',
      amount: { amountMinor: '100000', currency: 'USD' },
    });

    expect(response.status).toBe(400);
    expect(Object.keys(response.body.details)).toEqual(['idempotencyKey']);
    expectValidAgainst(ERROR_REF, response.body);
    expectNoInternalKeys(response.body);
  });

  it('429 is reachable with RATE_LIMITED and a Retry-After header', async () => {
    const organisationId = await createOrganisation('contract-429');
    const programId = await createProgram(organisationId, 1_000_000_000_000n);
    const token = tokenFor(organisationId, WRITE_SCOPE);

    for (let i = 0; i < RATE_LIMIT_WRITE_PER_MINUTE; i += 1) {
      const accepted = await post(programId, token, `contract-429-key-${i}`, {
        invoiceId: `contract-inv-429-${i}`,
        amount: { amountMinor: '1', currency: 'USD' },
      });
      expect(accepted.status).toBe(201);
    }

    const blocked = await post(programId, token, 'contract-429-key-blocked', {
      invoiceId: 'contract-inv-429-blocked',
      amount: { amountMinor: '1', currency: 'USD' },
    });

    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expectValidAgainst(ERROR_REF, blocked.body);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    expectNoInternalKeys(blocked.body);
  });

  it('503 is reachable with POSITION_UNVERIFIED', async () => {
    const organisationId = await createOrganisation('contract-503');
    const programId = await createProgram(organisationId, 1_000_000_000n);
    const token = tokenFor(organisationId, WRITE_SCOPE);

    await owner.query(
      `UPDATE program SET position_verified = FALSE WHERE id = $1`,
      [programId],
    );

    const response = await post(programId, token, 'contract-503-key', {
      invoiceId: 'contract-inv-503',
      amount: { amountMinor: '100000', currency: 'USD' },
    });

    expect(response.status).toBe(503);
    expectValidAgainst(ERROR_REF, response.body);
    expect(response.body.code).toBe('POSITION_UNVERIFIED');
    expectNoInternalKeys(response.body);
  });

  it('no error body contains a stack, sql or query key at any depth', async () => {
    const organisationId = await createOrganisation('contract-leak');
    const programId = await createProgram(organisationId, 1_000_000_000n);
    const writeToken = tokenFor(organisationId, WRITE_SCOPE);
    const readToken = tokenFor(organisationId, 'capacity:read');

    const bodies: unknown[] = [];

    const missingKey = await post(programId, writeToken, undefined, {
      invoiceId: 'contract-leak-missing',
      amount: { amountMinor: '100000', currency: 'USD' },
    });
    expect(missingKey.status).toBe(400);
    bodies.push(missingKey.body);

    const wrongScope = await post(programId, readToken, 'contract-leak-scope', {
      invoiceId: 'contract-leak-scope',
      amount: { amountMinor: '100000', currency: 'USD' },
    });
    expect(wrongScope.status).toBe(403);
    bodies.push(wrongScope.body);

    const wrongOrg = await post(
      CONTOSO_USD_PROGRAM_ID,
      tokenFor(NORTHWIND_ORGANISATION_ID, WRITE_SCOPE),
      'contract-leak-org',
      {
        invoiceId: 'contract-leak-org',
        amount: { amountMinor: '100000', currency: 'USD' },
      },
    );
    expect(wrongOrg.status).toBe(404);
    bodies.push(wrongOrg.body);

    const first = await post(programId, writeToken, 'contract-leak-conflict', {
      invoiceId: 'contract-leak-conflict',
      amount: { amountMinor: '100000', currency: 'USD' },
    });
    expect(first.status).toBe(201);
    const conflict = await post(programId, writeToken, 'contract-leak-conflict', {
      invoiceId: 'contract-leak-conflict',
      amount: { amountMinor: '200000', currency: 'USD' },
    });
    expect(conflict.status).toBe(409);
    bodies.push(conflict.body);

    await owner.query(
      `UPDATE program SET position_verified = FALSE WHERE id = $1`,
      [programId],
    );
    const unverified = await post(programId, writeToken, 'contract-leak-503', {
      invoiceId: 'contract-leak-503',
      amount: { amountMinor: '100000', currency: 'USD' },
    });
    expect(unverified.status).toBe(503);
    bodies.push(unverified.body);

    for (const body of bodies) {
      expectNoInternalKeys(body);
    }

    const serialised = bodies.map((body) => JSON.stringify(body)).join('\n');
    expect(serialised).not.toContain('"stack"');
    expect(serialised).not.toContain('"sql"');
    expect(serialised).not.toContain('"query"');
  });
});
