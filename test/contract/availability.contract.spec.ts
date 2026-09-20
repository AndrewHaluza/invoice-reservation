import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { sign } from 'jsonwebtoken';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createValidationPipe } from '../../src/shared/validation/create-validation-pipe';
import { openapiValidator } from '../support/openapi';
import { PostgresFixture, startPostgres } from '../support/postgres-container';
import { RedisFixture, startRedis } from '../support/redis-container';

jest.setTimeout(180_000);

const JWT_SECRET = 'integration-test-secret-0123456789abcdef';
const RATE_LIMIT_READ_PER_MINUTE = 600;
const RATE_LIMIT_WRITE_PER_MINUTE = 120;

const AVAILABILITY_REF = '#/components/schemas/Availability';
const RESERVATION_REF = '#/components/schemas/Reservation';
const LEDGER_ENTRY_REF = '#/components/schemas/LedgerEntry';
const PAGE_REF = '#/components/schemas/Page';
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

const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

describe('availability and audit read contract', () => {
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
    localReservedMinor = 0n,
  ): Promise<string> => {
    const rows = await owner.query<{ id: string }[]>(
      `INSERT INTO program
         (organisation_id, currency, credit_limit_minor, local_reserved_minor)
       VALUES ($1, 'USD', $2, $3)
       RETURNING id`,
      [
        organisationId,
        creditLimitMinor.toString(),
        localReservedMinor.toString(),
      ],
    );
    const id = rows[0]?.id;
    if (id === undefined) {
      throw new Error('expected the program insert to return one row');
    }
    return id;
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

  it('reports a null lag for a program with no applied treasury message', async () => {
    const organisationId = await createOrganisation('availability-shape');
    const programId = await createProgram(organisationId, 1_000_000_000n);
    const token = tokenFor(organisationId, 'capacity:read');

    const response = await request(app.getHttpServer())
      .get(`/v1/programs/${programId}/availability`)
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expectValidAgainst(AVAILABILITY_REF, response.body);

    expect(response.body.programId).toBe(programId);
    expect(response.body.currency).toBe('USD');
    expect(response.body.creditLimit.amountMinor).toBe('1000000000');
    expect(response.body.reserved.total.amountMinor).toBe('0');
    expect(response.body.reserved.local.amountMinor).toBe('0');
    expect(response.body.reserved.treasury.amountMinor).toBe('0');

    // Signed, never floored.
    expect(typeof response.body.available.amountMinor).toBe('string');
    expect(response.body.available.amountMinor).toBe('1000000000');

    expect(response.body.overLimit.active).toBe(false);
    expect(response.body.overLimit.since).toBeNull();

    expect(typeof response.body.positionChangedAt).toBe('string');
    expect(ISO_8601.test(response.body.positionChangedAt)).toBe(true);

    // The treasury object is present and non-null before any treasury state
    // exists; `0` for lagSeconds would be a false claim of currency.
    expect(response.body.treasury).not.toBeNull();
    expect(response.body.treasury.appliedVersion).toBe(0);
    expect(response.body.treasury.effectiveAt).toBeNull();
    expect(response.body.treasury.lagSeconds).toBeNull();

    expect(typeof response.body.positionVerified).toBe('boolean');
    expect(response.body.positionVerified).toBe(true);
    expect(typeof response.body.investigationRequired).toBe('boolean');
    expect(response.body.investigationRequired).toBe(false);

    if (response.body.reconciliationPending !== undefined) {
      expect(typeof response.body.reconciliationPending).toBe('boolean');
    }
  });

  it('reports a signed negative available for an over-limit program', async () => {
    const organisationId = await createOrganisation('availability-over-limit');
    const programId = await createProgram(organisationId, 100n, 200n);
    const token = tokenFor(organisationId, 'capacity:read');

    const response = await request(app.getHttpServer())
      .get(`/v1/programs/${programId}/availability`)
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expectValidAgainst(AVAILABILITY_REF, response.body);
    expect(response.body.available.amountMinor).toBe('-100');
    expect(response.body.overLimit.active).toBe(true);
  });

  it('answers 403 INSUFFICIENT_SCOPE without capacity:read', async () => {
    const organisationId = await createOrganisation('availability-scope');
    const programId = await createProgram(organisationId, 1_000_000_000n);
    const token = tokenFor(organisationId, 'capacity:write');

    const response = await request(app.getHttpServer())
      .get(`/v1/programs/${programId}/availability`)
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('INSUFFICIENT_SCOPE');
    expectValidAgainst(ERROR_REF, response.body);
  });

  it("answers 404 NOT_FOUND for another organisation's program", async () => {
    const ownerOrganisation = await createOrganisation('availability-owner-org');
    const foreignOrganisation = await createOrganisation(
      'availability-foreign-org',
    );
    const foreignProgram = await createProgram(foreignOrganisation, 1_000n);
    const token = tokenFor(ownerOrganisation, 'capacity:read');

    const response = await request(app.getHttpServer())
      .get(`/v1/programs/${foreignProgram}/availability`)
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
    expectValidAgainst(ERROR_REF, response.body);
  });

  it('lists reservations as a Page of Reservation and fetches one by invoice', async () => {
    const organisationId = await createOrganisation('reservation-reads');
    const programId = await createProgram(organisationId, 1_000_000_000n);
    const writeToken = tokenFor(organisationId, 'capacity:write');
    const readToken = tokenFor(organisationId, 'capacity:read');

    const reserved = await request(app.getHttpServer())
      .post(`/v1/programs/${programId}/reservations`)
      .set('Authorization', `Bearer ${writeToken}`)
      .set('Idempotency-Key', 'reservation-reads-key-1')
      .send({
        invoiceId: 'reservation-reads-invoice-1',
        amount: { amountMinor: '100000', currency: 'USD' },
      });
    expect(reserved.status).toBe(201);

    const list = await request(app.getHttpServer())
      .get(`/v1/programs/${programId}/reservations`)
      .set('Authorization', `Bearer ${readToken}`);

    expect(list.status).toBe(200);
    expectValidAgainst(PAGE_REF, list.body);
    expect(Array.isArray(list.body.items)).toBe(true);
    expect(list.body.items).toHaveLength(1);
    for (const item of list.body.items) {
      expectValidAgainst(RESERVATION_REF, item);
    }

    const single = await request(app.getHttpServer())
      .get(`/v1/programs/${programId}/reservations/reservation-reads-invoice-1`)
      .set('Authorization', `Bearer ${readToken}`);

    expect(single.status).toBe(200);
    expectValidAgainst(RESERVATION_REF, single.body);
    expect(single.body.invoiceId).toBe('reservation-reads-invoice-1');

    const missing = await request(app.getHttpServer())
      .get(`/v1/programs/${programId}/reservations/no-such-invoice`)
      .set('Authorization', `Bearer ${readToken}`);

    expect(missing.status).toBe(404);
    expectValidAgainst(ERROR_REF, missing.body);
    expect(missing.body.code).toBe('NOT_FOUND');
  });

  it('answers 403 INSUFFICIENT_SCOPE on the ledger without capacity:audit', async () => {
    const organisationId = await createOrganisation('ledger-scope');
    const programId = await createProgram(organisationId, 1_000_000_000n);
    const readToken = tokenFor(organisationId, 'capacity:read');

    const response = await request(app.getHttpServer())
      .get(`/v1/programs/${programId}/ledger`)
      .set('Authorization', `Bearer ${readToken}`);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('INSUFFICIENT_SCOPE');
    expectValidAgainst(ERROR_REF, response.body);
  });

  it('reads the ledger as a Page of LedgerEntry with capacity:audit', async () => {
    const organisationId = await createOrganisation('ledger-reads');
    const programId = await createProgram(organisationId, 1_000_000_000n);
    const writeToken = tokenFor(organisationId, 'capacity:write');
    const auditToken = tokenFor(organisationId, 'capacity:audit');

    await request(app.getHttpServer())
      .post(`/v1/programs/${programId}/reservations`)
      .set('Authorization', `Bearer ${writeToken}`)
      .set('Idempotency-Key', 'ledger-reads-key-1')
      .send({
        invoiceId: 'ledger-reads-invoice-1',
        amount: { amountMinor: '100000', currency: 'USD' },
      });

    const response = await request(app.getHttpServer())
      .get(`/v1/programs/${programId}/ledger`)
      .set('Authorization', `Bearer ${auditToken}`);

    expect(response.status).toBe(200);
    expectValidAgainst(PAGE_REF, response.body);
    expect(Array.isArray(response.body.items)).toBe(true);
    expect(response.body.items).toHaveLength(1);

    const entry = response.body.items[0];
    expectValidAgainst(LEDGER_ENTRY_REF, entry);
    expect(entry.component).toBe('LOCAL');
    expect(entry.cause).toBe('RESERVATION');
    expect(typeof entry.delta.amountMinor).toBe('string');
    expect(entry.delta.amountMinor).toBe('100000');
    expect(entry.delta.currency).toBe('USD');

    // Sequence is gapless and totally ordered per program; the first locally
    // written entry is sequence 1.
    expect(entry.sequence).toBe(1);
    expect(response.body.nextCursor).toBeNull();
  });
});
