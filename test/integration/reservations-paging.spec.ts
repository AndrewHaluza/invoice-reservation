import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import {
  AuditReadService,
  ListReservationsQuery,
} from '../../src/capacity/application/audit-read.service';
import { PostgresFixture, startPostgres } from '../support/postgres-container';
import { RedisFixture, startRedis } from '../support/redis-container';

jest.setTimeout(300_000);

const JWT_SECRET = 'integration-test-secret-0123456789abcdef';
const RATE_LIMIT_READ_PER_MINUTE = 600;
const RATE_LIMIT_WRITE_PER_MINUTE = 120;
const PAGE_LIMIT = 2;

const savedEnv = new Map<string, string | undefined>();

const setEnv = (key: string, value: string): void => {
  savedEnv.set(key, process.env[key]);
  process.env[key] = value;
};

describe('reservations paging', () => {
  let postgres: PostgresFixture;
  let redis: RedisFixture;
  let owner: DataSource;
  let app: INestApplication;
  let service: AuditReadService;

  const insertProgram = async (name: string): Promise<string> => {
    const organisationRows = await owner.query<{ id: string }[]>(
      `INSERT INTO organisation (name) VALUES ($1) RETURNING id`,
      [name],
    );
    const organisationId = organisationRows[0]?.id;
    if (organisationId === undefined) {
      throw new Error('expected the organisation insert to return one row');
    }

    const programRows = await owner.query<{ id: string }[]>(
      `INSERT INTO program (organisation_id, currency, credit_limit_minor)
       VALUES ($1, 'USD', $2)
       RETURNING id`,
      [organisationId, 1_000_000],
    );
    const programId = programRows[0]?.id;
    if (programId === undefined) {
      throw new Error('expected the program insert to return one row');
    }
    return programId;
  };

  const insertReservation = async (
    programId: string,
    invoiceId: string,
    createdAt: string,
  ): Promise<void> => {
    await owner.query(
      `INSERT INTO invoice_reservation
         (program_id, invoice_id, invoice_amount_minor, invoice_currency,
          program_currency, reserved_minor, outstanding_invoice_minor,
          outstanding_reserved_minor, status, origin, created_at, updated_at)
       VALUES ($1, $2, 1000, 'USD', 'USD', 1000, 1000, 1000, 'ACTIVE', 'LOCAL',
               $3::timestamptz, $3::timestamptz)`,
      [programId, invoiceId, createdAt],
    );
  };

  const collectAllInvoiceIds = async (programId: string): Promise<string[]> => {
    const collected: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const query: ListReservationsQuery =
        cursor === undefined
          ? { limit: PAGE_LIMIT }
          : { limit: PAGE_LIMIT, cursor };
      const page = await service.listReservations(programId, query);
      collected.push(...page.items.map((item) => item.invoiceId));
      if (page.nextCursor === null) {
        return collected;
      }
      cursor = page.nextCursor;
    }
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

    setEnv('DATABASE_URL', postgres.appUrl);

    const { AppModule } = await import('../../src/app.module');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.listen(0);

    service = app.get(AuditReadService);
  });

  afterAll(async () => {
    if (app !== undefined) {
      await app.close();
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

  it('returns every reservation across pages when timestamps collide at millisecond precision', async () => {
    const programId = await insertProgram('reservations-paging-micros');
    const expected: string[] = [];
    for (let index = 1; index <= 6; index += 1) {
      const invoiceId = `micros-invoice-${index}`;
      await insertReservation(
        programId,
        invoiceId,
        `2026-01-01T00:00:00.50000${index}Z`,
      );
      expected.push(invoiceId);
    }

    const collected = await collectAllInvoiceIds(programId);

    expect(collected).toHaveLength(6);
    expect(new Set(collected)).toEqual(new Set(expected));
  });

  it('pages deterministically when created_at is exactly equal', async () => {
    const programId = await insertProgram('reservations-paging-equal');
    const expected: string[] = [];
    for (let index = 1; index <= 4; index += 1) {
      const invoiceId = `equal-invoice-${index}`;
      await insertReservation(
        programId,
        invoiceId,
        '2026-01-01T00:00:01.000000Z',
      );
      expected.push(invoiceId);
    }

    const collected = await collectAllInvoiceIds(programId);

    expect(collected).toHaveLength(4);
    expect(new Set(collected).size).toBe(4);
    expect(new Set(collected)).toEqual(new Set(expected));
  });
});
