import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { sign } from 'jsonwebtoken';
import request from 'supertest';
import { DataSource } from 'typeorm';
import {
  NORTHWIND_ORGANISATION_ID,
  NORTHWIND_USD_PROGRAM_ID,
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

describe('release contract', () => {
  let postgres: PostgresFixture;
  let redis: RedisFixture;
  let owner: DataSource;
  let app: INestApplication;

  const organisationId = NORTHWIND_ORGANISATION_ID;
  const programId = NORTHWIND_USD_PROGRAM_ID;
  const token = tokenFor(organisationId, WRITE_SCOPE);

  const reserve = (key: string, invoiceId: string, amountMinor: string) =>
    request(app.getHttpServer())
      .post(`/v1/programs/${programId}/reservations`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({ invoiceId, amount: { amountMinor, currency: 'USD' } });

  const release = (
    key: string,
    invoiceId: string,
    amountMinor: string,
    currency = 'USD',
  ) =>
    request(app.getHttpServer())
      .post(`/v1/programs/${programId}/reservations/${invoiceId}/releases`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({ amount: { amountMinor, currency } });

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
      `INSERT INTO organisation (id, name) VALUES ($1, $2)`,
      [organisationId, 'Northwind Trading'],
    );
    await owner.query(
      `INSERT INTO program (id, organisation_id, currency, credit_limit_minor)
       VALUES ($1, $2, 'USD', $3)`,
      [programId, organisationId, '1000000000'],
    );

    setEnv('DATABASE_URL', postgres.appUrl);

    const { AppModule } = await import('../../src/app.module');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
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

  it('201 validates against ReservationResponse for a fresh release', async () => {
    const invoiceId = 'contract-rel-201';
    await reserve('contract-rel-201-reserve', invoiceId, '100000');

    const response = await release('contract-rel-201-release', invoiceId, '40000');

    expect(response.status).toBe(201);
    expectValidAgainst(RESERVATION_RESPONSE_REF, response.body);
    expect(typeof response.body.reservation).toBe('object');
    expect(typeof response.body.availability).toBe('object');
    expect(response.body.reservation.status).toBe('PARTIALLY_RELEASED');
    expect(response.body.reservation.outstanding.reserved.amountMinor).toBe(
      '60000',
    );
    expect(response.text).toContain('"amountMinor":"');
  });

  it('200 with an identical body for an idempotent replay', async () => {
    const invoiceId = 'contract-rel-200';
    await reserve('contract-rel-200-reserve', invoiceId, '100000');

    const first = await release('contract-rel-200-release', invoiceId, '40000');
    const second = await release('contract-rel-200-release', invoiceId, '40000');

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expectValidAgainst(RESERVATION_RESPONSE_REF, second.body);
    expect(second.body).toEqual(first.body);
  });

  it('409 CURRENCY_MISMATCH validates against Error', async () => {
    const invoiceId = 'contract-rel-currency';
    await reserve('contract-rel-currency-reserve', invoiceId, '100000');

    const response = await release(
      'contract-rel-currency-release',
      invoiceId,
      '40000',
      'EUR',
    );

    expect(response.status).toBe(409);
    expectValidAgainst(ERROR_REF, response.body);
    expect(response.body.code).toBe('CURRENCY_MISMATCH');
    expectNoInternalKeys(response.body);
  });

  it('409 RELEASE_EXCEEDS_RESERVED validates against Error', async () => {
    const invoiceId = 'contract-rel-exceeds';
    await reserve('contract-rel-exceeds-reserve', invoiceId, '100000');

    const response = await release(
      'contract-rel-exceeds-release',
      invoiceId,
      '200000',
    );

    expect(response.status).toBe(409);
    expectValidAgainst(ERROR_REF, response.body);
    expect(response.body.code).toBe('RELEASE_EXCEEDS_RESERVED');
    expectNoInternalKeys(response.body);
  });

  it('409 IDEMPOTENCY_CONFLICT when the same key carries different content', async () => {
    const invoiceId = 'contract-rel-conflict';
    await reserve('contract-rel-conflict-reserve', invoiceId, '100000');

    const first = await release(
      'contract-rel-conflict-release',
      invoiceId,
      '40000',
    );
    expect(first.status).toBe(201);

    const conflict = await release(
      'contract-rel-conflict-release',
      invoiceId,
      '30000',
    );

    expect(conflict.status).toBe(409);
    expectValidAgainst(ERROR_REF, conflict.body);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
    expectNoInternalKeys(conflict.body);
  });

  it('409 RESERVATION_TERMINAL validates against Error', async () => {
    const invoiceId = 'contract-rel-terminal';
    await reserve('contract-rel-terminal-reserve', invoiceId, '100000');
    await release('contract-rel-terminal-first', invoiceId, '100000');

    const response = await release(
      'contract-rel-terminal-second',
      invoiceId,
      '1',
    );

    expect(response.status).toBe(409);
    expectValidAgainst(ERROR_REF, response.body);
    expect(response.body.code).toBe('RESERVATION_TERMINAL');
    expectNoInternalKeys(response.body);
  });

  it('404 NOT_FOUND validates against Error', async () => {
    const response = await release(
      'contract-rel-missing-release',
      'contract-rel-missing',
      '100',
    );

    expect(response.status).toBe(404);
    expectValidAgainst(ERROR_REF, response.body);
    expect(response.body.code).toBe('NOT_FOUND');
    expectNoInternalKeys(response.body);
  });

  it('409 IDEMPOTENCY_CONFLICT when a key first used to reserve is reused for a release', async () => {
    const invoiceId = 'contract-rel-cross-op';
    const key = 'contract-rel-cross-op-key';

    const reserved = await reserve(key, invoiceId, '40000');
    expect(reserved.status).toBe(201);

    const response = await release(key, invoiceId, '40000');

    expect(response.status).toBe(409);
    expectValidAgainst(ERROR_REF, response.body);
    expect(response.body.code).toBe('IDEMPOTENCY_CONFLICT');
    expectNoInternalKeys(response.body);
  });

  it('503 POSITION_UNVERIFIED validates against Error', async () => {
    const invoiceId = 'contract-rel-unverified';
    await reserve('contract-rel-unverified-reserve', invoiceId, '100000');
    await owner.query(
      `UPDATE program SET position_verified = FALSE WHERE id = $1`,
      [programId],
    );

    try {
      const response = await release(
        'contract-rel-unverified-release',
        invoiceId,
        '40000',
      );

      expect(response.status).toBe(503);
      expectValidAgainst(ERROR_REF, response.body);
      expect(response.body.code).toBe('POSITION_UNVERIFIED');
      expectNoInternalKeys(response.body);
    } finally {
      await owner.query(
        `UPDATE program SET position_verified = TRUE WHERE id = $1`,
        [programId],
      );
    }
  });

  it('400 on a malformed amount validates against Error', async () => {
    const invoiceId = 'contract-rel-malformed';
    await reserve('contract-rel-malformed-reserve', invoiceId, '100000');

    const response = await release(
      'contract-rel-malformed-release',
      invoiceId,
      '0',
    );

    expect(response.status).toBe(400);
    expectValidAgainst(ERROR_REF, response.body);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expectNoInternalKeys(response.body);
  });

  it('no release error body contains a stack, sql or query key at any depth', async () => {
    const bodies: unknown[] = [];

    const mismatchInvoice = 'contract-leak-currency';
    await reserve('contract-leak-currency-reserve', mismatchInvoice, '100000');
    const mismatch = await release(
      'contract-leak-currency-release',
      mismatchInvoice,
      '100',
      'EUR',
    );
    expect(mismatch.status).toBe(409);
    bodies.push(mismatch.body);

    const missing = await release(
      'contract-leak-missing-release',
      'contract-leak-missing',
      '100',
    );
    expect(missing.status).toBe(404);
    bodies.push(missing.body);

    const malformedInvoice = 'contract-leak-malformed';
    await reserve('contract-leak-malformed-reserve', malformedInvoice, '100000');
    const malformed = await release(
      'contract-leak-malformed-release',
      malformedInvoice,
      '0',
    );
    expect(malformed.status).toBe(400);
    bodies.push(malformed.body);

    for (const body of bodies) {
      expectNoInternalKeys(body);
    }

    const serialised = bodies.map((body) => JSON.stringify(body)).join('\n');
    expect(serialised).not.toContain('"stack"');
    expect(serialised).not.toContain('"sql"');
    expect(serialised).not.toContain('"query"');
  });
});
