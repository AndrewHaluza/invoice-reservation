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
const AUDIT_SCOPE = 'capacity:audit';

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

interface LedgerRow {
  cause: string;
  delta_minor: string;
}

interface LedgerItem {
  cause: string;
  originReference: string | null;
}

describe('cancellation (US3, FR-025-027)', () => {
  let postgres: PostgresFixture;
  let redis: RedisFixture;
  let owner: DataSource;
  let app: INestApplication;

  const organisationId = NORTHWIND_ORGANISATION_ID;
  const programId = NORTHWIND_USD_PROGRAM_ID;
  const token = tokenFor(organisationId, WRITE_SCOPE);
  const auditToken = tokenFor(organisationId, AUDIT_SCOPE);

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

  const cancel = (
    key: string,
    invoiceId: string,
    reason: 'CANCELLED' | 'WRITTEN_OFF' = 'CANCELLED',
    note?: string,
  ) =>
    request(app.getHttpServer())
      .post(`/v1/programs/${programId}/reservations/${invoiceId}/cancellation`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(note === undefined ? { reason } : { reason, note });

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

  const ledgerFor = async (invoiceId: string): Promise<LedgerRow[]> =>
    owner.query<LedgerRow[]>(
      `SELECT cause, delta_minor::text AS delta_minor
         FROM capacity_ledger_entry
        WHERE program_id = $1 AND component = 'LOCAL' AND origin_reference = $2
        ORDER BY sequence`,
      [programId, invoiceId],
    );

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

  it('cancels an ACTIVE reservation, returning all capacity with cause CANCELLATION', async () => {
    const invoiceId = 'cancel-inv-active';
    const localReservedBefore = await readLocalReserved();

    const reserved = await reserve('cancel-active-reserve', invoiceId, '33333');
    expect(reserved.status).toBe(201);

    const response = await cancel('cancel-active-key', invoiceId, 'CANCELLED');
    expect(response.status).toBe(201);

    const reservation = await readReservation(invoiceId);
    expect(reservation.status).toBe('CANCELLED');
    expect(reservation.outstanding_reserved_minor).toBe('0');

    const entries = await ledgerFor(invoiceId);
    const cancellation = entries.filter(
      (entry) => entry.cause === 'CANCELLATION',
    );
    expect(cancellation).toHaveLength(1);
    expect(cancellation[0]?.delta_minor).toBe('-36166');

    expect(await readLocalReserved()).toBe(localReservedBefore);
  });

  it('writes off a partially released reservation with cause WRITE_OFF and nets to zero', async () => {
    const invoiceId = 'cancel-inv-partial';

    const reserved = await reserve('cancel-partial-reserve', invoiceId, '33333');
    expect(reserved.status).toBe(201);

    const released = await release('cancel-partial-release', invoiceId, '20000');
    expect(released.status).toBe(201);

    const afterRelease = await readReservation(invoiceId);
    expect(afterRelease.status).toBe('PARTIALLY_RELEASED');

    const response = await cancel('cancel-partial-key', invoiceId, 'CANCELLED');
    expect(response.status).toBe(201);

    const reservation = await readReservation(invoiceId);
    expect(reservation.status).toBe('WRITTEN_OFF');
    expect(reservation.outstanding_reserved_minor).toBe('0');

    const entries = await ledgerFor(invoiceId);
    expect(entries.map((entry) => entry.cause)).toEqual([
      'RESERVATION',
      'RELEASE',
      'WRITE_OFF',
    ]);
    expect(await localLedgerSum(invoiceId)).toBe('0');
  });

  it('refuses a second cancellation with a new key as RESERVATION_TERMINAL and writes nothing', async () => {
    const invoiceId = 'cancel-inv-twice';

    const reserved = await reserve('cancel-twice-reserve', invoiceId, '33333');
    expect(reserved.status).toBe(201);

    const first = await cancel('cancel-twice-first', invoiceId, 'CANCELLED');
    expect(first.status).toBe(201);

    const ledgerBefore = await countLocalLedger();

    const second = await cancel('cancel-twice-second', invoiceId, 'CANCELLED');
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('RESERVATION_TERMINAL');

    expect(await countLocalLedger()).toBe(ledgerBefore);

    const reservation = await readReservation(invoiceId);
    expect(reservation.status).toBe('CANCELLED');
  });

  it('replays an identical cancellation under the same key as 200', async () => {
    const invoiceId = 'cancel-inv-replay';

    const reserved = await reserve('cancel-replay-reserve', invoiceId, '33333');
    expect(reserved.status).toBe(201);

    const first = await cancel('cancel-replay-key', invoiceId, 'WRITTEN_OFF');
    const second = await cancel('cancel-replay-key', invoiceId, 'WRITTEN_OFF');

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it('refuses cancellation of a FULLY_RELEASED reservation as RESERVATION_TERMINAL', async () => {
    const invoiceId = 'cancel-inv-released';

    const reserved = await reserve('cancel-released-reserve', invoiceId, '33333');
    expect(reserved.status).toBe(201);

    const released = await release('cancel-released-release', invoiceId, '33333');
    expect(released.status).toBe(201);

    const response = await cancel('cancel-released-key', invoiceId, 'CANCELLED');
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('RESERVATION_TERMINAL');
  });

  it('does not return cancellation entries in an auditor query filtered to RELEASE', async () => {
    const invoiceId = 'cancel-inv-audit';

    const reserved = await reserve('cancel-audit-reserve', invoiceId, '33333');
    expect(reserved.status).toBe(201);

    const response = await cancel('cancel-audit-key', invoiceId, 'CANCELLED');
    expect(response.status).toBe(201);

    const releases = await request(app.getHttpServer())
      .get(`/v1/programs/${programId}/ledger`)
      .query({ cause: 'RELEASE', limit: 1000 })
      .set('Authorization', `Bearer ${auditToken}`);

    expect(releases.status).toBe(200);
    const releaseItems = releases.body.items as LedgerItem[];
    expect(
      releaseItems.some((item) => item.originReference === invoiceId),
    ).toBe(false);

    const cancellations = await request(app.getHttpServer())
      .get(`/v1/programs/${programId}/ledger`)
      .query({ cause: 'CANCELLATION', limit: 1000 })
      .set('Authorization', `Bearer ${auditToken}`);

    expect(cancellations.status).toBe(200);
    const cancellationItems = cancellations.body.items as LedgerItem[];
    expect(
      cancellationItems.some((item) => item.originReference === invoiceId),
    ).toBe(true);
  });
});
