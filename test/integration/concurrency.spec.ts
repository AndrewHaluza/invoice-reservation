import 'reflect-metadata';
import { Agent } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { sign } from 'jsonwebtoken';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { entities } from '../../src/capacity/infrastructure/entities';
import { createValidationPipe } from '../../src/shared/validation/create-validation-pipe';
import { PostgresFixture, startPostgres } from '../support/postgres-container';
import { RedisFixture, startRedis } from '../support/redis-container';

jest.setTimeout(300_000);

const JWT_SECRET = 'integration-test-secret-0123456789abcdef';
const RATE_LIMIT_PER_MINUTE = 100_000;
const WRITE_SCOPE = 'capacity:write';

const CONCURRENT_REQUESTS = 1_000;
const ACCEPTED_REQUESTS = 100;
const RESERVATION_MINOR = '1000';
const CREDIT_LIMIT_MINOR = '100000';

// macOS caps the listen backlog at kern.ipc.somaxconn (128 by default). Node's
// global agent imposes no socket cap (`maxSockets: Infinity`), so 1,000
// simultaneous connects overflow the accept queue and SYN retransmits surface as
// `connect ETIMEDOUT` — a transport failure, not a service contention failure.
// A bounded keep-alive pool still launches all 1,000 requests at once while
// holding the number of open sockets below the backlog.
const MAX_SOCKETS = 100;

const savedEnv = new Map<string, string | undefined>();

const setEnv = (key: string, value: string): void => {
  savedEnv.set(key, process.env[key]);
  process.env[key] = value;
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

describe('concurrency: reservations never breach the credit limit', () => {
  let postgres: PostgresFixture;
  let redis: RedisFixture;
  let owner: DataSource;
  let appDataSource: DataSource;
  let app: INestApplication;
  let organisationId: string;
  let programId: string;
  let token: string;
  let pool: Agent;

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
    setEnv('RATE_LIMIT_READ_PER_MINUTE', String(RATE_LIMIT_PER_MINUTE));
    setEnv('RATE_LIMIT_WRITE_PER_MINUTE', String(RATE_LIMIT_PER_MINUTE));

    const { dataSourceOptions } = await import('../../src/config/data-source');

    owner = new DataSource({
      ...dataSourceOptions,
      url: postgres.ownerUrl,
      entities: [],
    });
    await owner.initialize();
    await owner.runMigrations();

    const organisationRows = await owner.query<{ id: string }[]>(
      `INSERT INTO organisation (name) VALUES ($1) RETURNING id`,
      ['concurrency-org'],
    );
    const insertedOrganisationId = organisationRows[0]?.id;
    if (insertedOrganisationId === undefined) {
      throw new Error('expected the organisation insert to return one row');
    }
    organisationId = insertedOrganisationId;

    const programRows = await owner.query<{ id: string }[]>(
      `INSERT INTO program
         (organisation_id, currency, credit_limit_minor, local_reserved_minor,
          treasury_reserved_minor, next_sequence, position_verified)
       VALUES ($1, 'USD', $2, 0, 0, 1, TRUE)
       RETURNING id`,
      [organisationId, CREDIT_LIMIT_MINOR],
    );
    const insertedProgramId = programRows[0]?.id;
    if (insertedProgramId === undefined) {
      throw new Error('expected the program insert to return one row');
    }
    programId = insertedProgramId;

    setEnv('DATABASE_URL', postgres.appUrl);

    // The pool must not be the bottleneck: 1,000 transactions queue on the
    // single program row and each holds a connection while it waits.
    appDataSource = new DataSource({
      ...dataSourceOptions,
      url: postgres.appUrl,
      entities,
      migrations: [],
      extra: { max: 50 },
    });
    await appDataSource.initialize();

    token = sign(
      { org: organisationId, scope: WRITE_SCOPE, exp: nowSeconds() + 3600 },
      JWT_SECRET,
      { algorithm: 'HS256' },
    );

    const { AppModule } = await import('../../src/app.module');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DataSource)
      .useValue(appDataSource)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    await app.listen(0);
    pool = new Agent({ keepAlive: true, maxSockets: MAX_SOCKETS });
  });

  afterAll(async () => {
    pool?.destroy();
    if (app !== undefined) {
      const storage = app.get(
        ThrottlerStorage,
      ) as ThrottlerStorageRedisService;
      await app.close();
      storage.redis.disconnect();
    }
    if (appDataSource?.isInitialized) {
      await appDataSource.destroy();
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

  it('accepts exactly 100 of 1,000 concurrent reservations without a contention failure', async () => {
    const responses = await Promise.all(
      Array.from({ length: CONCURRENT_REQUESTS }, (_, index) =>
        request(app.getHttpServer())
          .post(`/v1/programs/${programId}/reservations`)
          .agent(pool)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', `concurrency-key-${index}`)
          .send({
            invoiceId: `inv-concurrency-${index}`,
            amount: { amountMinor: RESERVATION_MINOR, currency: 'USD' },
          }),
      ),
    );

    const statuses = responses.map((response) => response.status);
    const accepted = responses.filter((response) => response.status === 201);
    const refused = responses.filter((response) => response.status === 409);

    expect(accepted).toHaveLength(ACCEPTED_REQUESTS);
    expect(refused).toHaveLength(CONCURRENT_REQUESTS - ACCEPTED_REQUESTS);
    for (const response of refused) {
      expect(response.body.code).toBe('INSUFFICIENT_CAPACITY');
    }
    expect([...new Set(statuses)].sort()).toEqual([201, 409]);

    const programRows = await owner.query<{ local_reserved_minor: string }[]>(
      `SELECT local_reserved_minor::text AS local_reserved_minor
         FROM program WHERE id = $1`,
      [programId],
    );
    const localReservedMinor = programRows[0]?.local_reserved_minor;
    expect(localReservedMinor).toBe(CREDIT_LIMIT_MINOR);

    const ledgerSumRows = await owner.query<{ total: string }[]>(
      `SELECT COALESCE(SUM(delta_minor), 0)::text AS total
         FROM capacity_ledger_entry
        WHERE program_id = $1 AND component = 'LOCAL'`,
      [programId],
    );
    expect(BigInt(ledgerSumRows[0]?.total ?? '0')).toBe(
      BigInt(localReservedMinor ?? '0'),
    );

    const reservationCountRows = await owner.query<{ count: number }[]>(
      `SELECT COUNT(*)::int AS count FROM invoice_reservation`,
    );
    expect(reservationCountRows[0]?.count).toBe(ACCEPTED_REQUESTS);

    const sequenceRows = await owner.query<{ seq: string }[]>(
      `SELECT sequence::text AS seq
         FROM capacity_ledger_entry
        WHERE program_id = $1
        ORDER BY sequence`,
      [programId],
    );
    const sequences = sequenceRows.map((row) => Number(row.seq));
    expect(sequences).toEqual(
      Array.from({ length: sequences.length }, (_, index) => index + 1),
    );
  });
});
