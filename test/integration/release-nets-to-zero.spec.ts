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

interface ReservationRow {
  status: string;
  outstanding_invoice_minor: string;
  outstanding_reserved_minor: string;
}

describe('release nets to zero (SC-004a)', () => {
  let postgres: PostgresFixture;
  let redis: RedisFixture;
  let owner: DataSource;
  let app: INestApplication;

  const organisationId = NORTHWIND_ORGANISATION_ID;
  const programId = NORTHWIND_USD_PROGRAM_ID;
  const token = tokenFor(NORTHWIND_ORGANISATION_ID, WRITE_SCOPE);

  const reserve = (key: string, invoiceId: string, amountMinor: string) =>
    request(app.getHttpServer())
      .post(`/v1/programs/${programId}/reservations`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({ invoiceId, amount: { amountMinor, currency: 'EUR' } });

  const release = (key: string, invoiceId: string, amountMinor: string) =>
    request(app.getHttpServer())
      .post(`/v1/programs/${programId}/reservations/${invoiceId}/releases`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({ amount: { amountMinor, currency: 'EUR' } });

  const readReservation = async (
    invoiceId: string,
  ): Promise<ReservationRow> => {
    const rows = await owner.query<ReservationRow[]>(
      `SELECT status,
              outstanding_invoice_minor::text AS outstanding_invoice_minor,
              outstanding_reserved_minor::text AS outstanding_reserved_minor
         FROM invoice_reservation
        WHERE program_id = $1 AND invoice_id = $2`,
      [programId, invoiceId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`reservation ${invoiceId} not found`);
    }
    return row;
  };

  const localLedgerSum = async (invoiceId: string): Promise<string> => {
    const rows = await owner.query<{ total: string }[]>(
      `SELECT COALESCE(SUM(delta_minor), 0)::text AS total
         FROM capacity_ledger_entry
        WHERE program_id = $1 AND component = 'LOCAL' AND origin_reference = $2`,
      [programId, invoiceId],
    );
    return rows[0]?.total ?? '';
  };

  const readLocalReserved = async (): Promise<string> => {
    const rows = await owner.query<{ local_reserved_minor: string }[]>(
      `SELECT local_reserved_minor::text AS local_reserved_minor
         FROM program WHERE id = $1`,
      [programId],
    );
    return rows[0]?.local_reserved_minor ?? '';
  };

  const countLocalLedger = async (): Promise<number> => {
    const rows = await owner.query<{ count: number }[]>(
      `SELECT COUNT(*)::int AS count
         FROM capacity_ledger_entry
        WHERE program_id = $1 AND component = 'LOCAL'`,
      [programId],
    );
    return rows[0]?.count ?? -1;
  };

  beforeAll(async () => {
    postgres = await startPostgres();
    redis = await startRedis();

    setEnv('MIGRATION_DATABASE_URL', postgres.ownerUrl);
    setEnv('DATABASE_URL', postgres.ownerUrl);
    setEnv('REDIS_URL', redis.url);
    setEnv('KAFKA_BROKERS', 'localhost:9093');
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
      `INSERT INTO organisation (id, name) VALUES ($1, $2), ($3, $4)`,
      [
        organisationId,
        'Northwind Trading',
        CONTOSO_ORGANISATION_ID,
        'Contoso Finance',
      ],
    );
    await owner.query(
      `INSERT INTO program (id, organisation_id, currency, credit_limit_minor)
       VALUES ($1, $2, 'USD', $3), ($4, $5, 'USD', $6)`,
      [
        programId,
        organisationId,
        '1000000000',
        CONTOSO_USD_PROGRAM_ID,
        CONTOSO_ORGANISATION_ID,
        '200000000',
      ],
    );
    await owner.query(
      `INSERT INTO fx_rate (base_currency, quote_currency, effective_at, rate, source)
       VALUES ('EUR', 'USD', to_timestamp(0), '1.0850000000', 'seed')`,
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

  it('nets two instalments of a 33333 EUR invoice to exactly zero', async () => {
    const invoiceId = 'rel-inv-two';
    const localReservedBefore = await readLocalReserved();

    const reserved = await reserve('rel-two-reserve', invoiceId, '33333');
    expect(reserved.status).toBe(201);

    const afterReserve = await readReservation(invoiceId);
    expect(afterReserve.outstanding_reserved_minor).toBe('36166');

    const first = await release('rel-two-first', invoiceId, '20000');
    expect(first.status).toBe(201);

    const second = await release('rel-two-second', invoiceId, '13333');
    expect(second.status).toBe(201);

    const reservation = await readReservation(invoiceId);
    expect(reservation.status).toBe('FULLY_RELEASED');
    expect(reservation.outstanding_invoice_minor).toBe('0');
    expect(reservation.outstanding_reserved_minor).toBe('0');
    expect(await localLedgerSum(invoiceId)).toBe('0');
    expect(await readLocalReserved()).toBe(localReservedBefore);
  });

  it('nets a single full-instalment release of 33333 EUR to exactly zero', async () => {
    const invoiceId = 'rel-inv-full';
    const localReservedBefore = await readLocalReserved();

    const reserved = await reserve('rel-full-reserve', invoiceId, '33333');
    expect(reserved.status).toBe(201);

    const released = await release('rel-full-release', invoiceId, '33333');
    expect(released.status).toBe(201);

    const reservation = await readReservation(invoiceId);
    expect(reservation.status).toBe('FULLY_RELEASED');
    expect(reservation.outstanding_invoice_minor).toBe('0');
    expect(reservation.outstanding_reserved_minor).toBe('0');
    expect(await localLedgerSum(invoiceId)).toBe('0');
    expect(await readLocalReserved()).toBe(localReservedBefore);
  });

  it('refuses a release one minor unit above the reserved remainder and writes nothing', async () => {
    const invoiceId = 'rel-inv-over';

    const reserved = await reserve('rel-over-reserve', invoiceId, '33333');
    expect(reserved.status).toBe(201);

    const ledgerBefore = await countLocalLedger();

    const refused = await release('rel-over-release', invoiceId, '33334');
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('RELEASE_EXCEEDS_RESERVED');

    expect(await countLocalLedger()).toBe(ledgerBefore);

    const reservation = await readReservation(invoiceId);
    expect(reservation.status).toBe('ACTIVE');
    expect(reservation.outstanding_invoice_minor).toBe('33333');
    expect(reservation.outstanding_reserved_minor).toBe('36166');
  });

  it('answers 403 INSUFFICIENT_SCOPE when the token lacks capacity:write', async () => {
    const response = await request(app.getHttpServer())
      .post(`/v1/programs/${programId}/reservations/rel-scope/releases`)
      .set('Authorization', `Bearer ${tokenFor(organisationId, 'capacity:read')}`)
      .set('Idempotency-Key', 'rel-scope-key')
      .send({ amount: { amountMinor: '1', currency: 'EUR' } });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('INSUFFICIENT_SCOPE');
  });

  it("answers 404 NOT_FOUND for another organisation's program", async () => {
    const response = await request(app.getHttpServer())
      .post(
        `/v1/programs/${CONTOSO_USD_PROGRAM_ID}/reservations/rel-foreign/releases`,
      )
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'rel-foreign-key')
      .send({ amount: { amountMinor: '1', currency: 'EUR' } });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });
});
