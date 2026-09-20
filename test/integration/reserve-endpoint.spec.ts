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
  NORTHWIND_USD_PROGRAM_ID,
} from '../../scripts/seed';
import { createValidationPipe } from '../../src/shared/validation/create-validation-pipe';
import { PostgresFixture, startPostgres } from '../support/postgres-container';
import { RedisFixture, startRedis } from '../support/redis-container';

jest.setTimeout(180_000);

const JWT_SECRET = 'integration-test-secret-0123456789abcdef';
const RATE_LIMIT_READ_PER_MINUTE = 600;
const RATE_LIMIT_WRITE_PER_MINUTE = 120;
const WRITE_SCOPE = 'capacity:write';

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

describe('POST /v1/programs/:programId/reservations', () => {
  let postgres: PostgresFixture;
  let redis: RedisFixture;
  let owner: DataSource;
  let app: INestApplication;

  const northwindOrganisationId = NORTHWIND_ORGANISATION_ID;
  const northwindUsdProgramId = NORTHWIND_USD_PROGRAM_ID;
  const contosoOrganisationId = CONTOSO_ORGANISATION_ID;
  const contosoUsdProgramId = CONTOSO_USD_PROGRAM_ID;

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
        northwindOrganisationId,
        'Northwind Trading',
        contosoOrganisationId,
        'Contoso Finance',
      ],
    );
    await owner.query(
      `INSERT INTO program (id, organisation_id, currency, credit_limit_minor)
       VALUES ($1, $2, 'USD', $3), ($4, $5, 'USD', $6)`,
      [
        northwindUsdProgramId,
        northwindOrganisationId,
        '1000000000',
        contosoUsdProgramId,
        contosoOrganisationId,
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

  it('answers 201 with the reservation and the reflected availability', async () => {
    const organisationId = await createOrganisation('endpoint-happy');
    const programId = await createProgram(organisationId, 1_000_000_000n);

    // Backdate the position so a stale response value is unambiguous.
    const stalePositionChangedAt = '2000-01-01T00:00:00.000Z';
    await owner.query(
      `UPDATE program SET position_changed_at = $2 WHERE id = $1`,
      [programId, stalePositionChangedAt],
    );

    const response = await post(
      programId,
      tokenFor(organisationId, WRITE_SCOPE),
      'happy-key-0001',
      {
        invoiceId: 'inv-happy-1',
        amount: { amountMinor: '100000', currency: 'USD' },
      },
    );

    expect(response.status).toBe(201);
    expect(typeof response.body.reservation).toBe('object');
    expect(typeof response.body.availability).toBe('object');
    expect(response.body.reservation.reserved.amountMinor).toBe('100000');
    expect(response.body.availability.available.amountMinor).toBe('999900000');
    expect(response.body.availability.reserved.local.amountMinor).toBe(
      '100000',
    );

    const rows = await owner.query<{ position_changed_at: Date }[]>(
      `SELECT position_changed_at FROM program WHERE id = $1`,
      [programId],
    );
    expect(response.body.availability.positionChangedAt).toBe(
      rows[0]?.position_changed_at.toISOString(),
    );
    expect(response.body.availability.positionChangedAt).not.toBe(
      stalePositionChangedAt,
    );
  });

  it('answers 200 with an identical body for an exact idempotent replay', async () => {
    const organisationId = await createOrganisation('endpoint-replay');
    const programId = await createProgram(organisationId, 1_000_000_000n);
    const token = tokenFor(organisationId, WRITE_SCOPE);
    const body = {
      invoiceId: 'inv-replay-1',
      amount: { amountMinor: '250000', currency: 'USD' },
    };

    const first = await post(programId, token, 'replay-key-0001', body);
    const second = await post(programId, token, 'replay-key-0001', body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it('answers 403 INSUFFICIENT_SCOPE when the token lacks capacity:write', async () => {
    const response = await post(
      northwindUsdProgramId,
      tokenFor(northwindOrganisationId, 'capacity:read'),
      'scope-key-0001',
      {
        invoiceId: 'inv-scope-1',
        amount: { amountMinor: '100000', currency: 'USD' },
      },
    );

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('INSUFFICIENT_SCOPE');
  });

  it("answers 404 NOT_FOUND for another organisation's program", async () => {
    const response = await post(
      contosoUsdProgramId,
      tokenFor(northwindOrganisationId, WRITE_SCOPE),
      'crossorg-key-0001',
      {
        invoiceId: 'inv-crossorg-1',
        amount: { amountMinor: '100000', currency: 'USD' },
      },
    );

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('answers 400 VALIDATION_FAILED when Idempotency-Key is missing', async () => {
    const response = await post(
      northwindUsdProgramId,
      tokenFor(northwindOrganisationId, WRITE_SCOPE),
      undefined,
      {
        invoiceId: 'inv-nokey-1',
        amount: { amountMinor: '100000', currency: 'USD' },
      },
    );

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

  it('caps the route at the write budget: the 121st write is 429', async () => {
    const organisationId = await createOrganisation('endpoint-throttle-write');
    const programId = await createProgram(organisationId, 1_000_000_000_000n);
    const token = tokenFor(organisationId, WRITE_SCOPE);

    for (let i = 0; i < RATE_LIMIT_WRITE_PER_MINUTE; i += 1) {
      const accepted = await post(programId, token, `write-budget-key-${i}`, {
        invoiceId: `inv-write-budget-${i}`,
        amount: { amountMinor: '1', currency: 'USD' },
      });
      expect(accepted.status).toBe(201);
    }

    const blocked = await post(programId, token, 'write-budget-key-blocked', {
      invoiceId: 'inv-write-budget-blocked',
      amount: { amountMinor: '1', currency: 'USD' },
    });

    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('does not cap writes at the read budget', async () => {
    const organisationId = await createOrganisation('endpoint-throttle-read');
    const programId = await createProgram(organisationId, 1_000_000_000_000n);
    const token = tokenFor(organisationId, WRITE_SCOPE);

    for (let i = 0; i < 100; i += 1) {
      const accepted = await post(programId, token, `read-budget-key-${i}`, {
        invoiceId: `inv-read-budget-${i}`,
        amount: { amountMinor: '1', currency: 'USD' },
      });
      expect(accepted.status).toBe(201);
    }

    const further = await post(programId, token, 'read-budget-key-further', {
      invoiceId: 'inv-read-budget-further',
      amount: { amountMinor: '1', currency: 'USD' },
    });

    expect(further.status).toBe(201);
  });
});
