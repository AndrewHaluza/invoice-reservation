import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { sign } from 'jsonwebtoken';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { RecoveryDetectionService } from '../../src/capacity/application/recovery-detection.service';
import { dataSourceOptions } from '../../src/config/data-source';
import { StreamCoordinates } from '../../src/shared/treasury/capacity-event';
import { ReconciliationSnapshot } from '../../src/shared/treasury/reconciliation-snapshot';
import { createValidationPipe } from '../../src/shared/validation/create-validation-pipe';
import { PostgresFixture, startPostgres } from '../support/postgres-container';
import { RedisFixture, startRedis } from '../support/redis-container';
import {
  buildTreasuryHarness,
  insertLocalReservation,
  insertOrganisation,
  insertProgram,
  TreasuryHarness,
} from '../support/treasury';

jest.setTimeout(180_000);

const JWT_SECRET = 'integration-test-secret-0123456789abcdef';
const LIMIT = 1_000_000_000;

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

describe('Recovery detection (FR-019d/FR-019e)', () => {
  let postgres: PostgresFixture;
  let redis: RedisFixture;
  let owner: DataSource;
  let app: INestApplication;
  let detection: RecoveryDetectionService;
  let harness: TreasuryHarness;

  let organisationA: string;
  let organisationB: string;
  let programA: string;
  let programB: string;

  const setVerified = (programId: string, verified: boolean): Promise<unknown> =>
    owner.query(`UPDATE program SET position_verified = $2 WHERE id = $1`, [
      programId,
      verified,
    ]);

  const readVerified = async (programId: string): Promise<boolean> => {
    const rows = await owner.query<{ position_verified: boolean }[]>(
      `SELECT position_verified FROM program WHERE id = $1`,
      [programId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('program not found');
    return row.position_verified;
  };

  beforeAll(async () => {
    postgres = await startPostgres();
    redis = await startRedis();

    owner = new DataSource({
      ...dataSourceOptions,
      url: postgres.ownerUrl,
      entities: [],
    });
    await owner.initialize();
    await owner.runMigrations();

    organisationA = await insertOrganisation(owner, 't092-org-a');
    organisationB = await insertOrganisation(owner, 't092-org-b');
    programA = await insertProgram(owner, organisationA, {
      currency: 'USD',
      creditLimitMinor: LIMIT,
      localReservedMinor: 1_000,
    });
    programB = await insertProgram(owner, organisationB, {
      currency: 'USD',
      creditLimitMinor: LIMIT,
    });
    await insertLocalReservation(owner, programA, {
      invoiceId: 'inv-t092-a',
      amountMinor: 1_000,
      treasuryReference: 'TRSY-T092-A',
    });

    setEnv('DATABASE_URL', postgres.appUrl);
    setEnv('MIGRATION_DATABASE_URL', postgres.ownerUrl);
    setEnv('REDIS_URL', redis.url);
    setEnv('KAFKA_BROKERS', 'localhost:9093');
    setEnv('KAFKA_LAG_PROBE_ENABLED', 'false');
    setEnv('KAFKA_SASL_USERNAME', 'capacity');
    setEnv('KAFKA_SASL_PASSWORD', 'capacity_local_dev');
    setEnv('JWT_SECRET', JWT_SECRET);

    const { AppModule } = await import('../../src/app.module');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    await app.listen(0);

    detection = app.get(RecoveryDetectionService);
    harness = buildTreasuryHarness(owner, { deltaGuardRatio: 1 });
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

  it('refuses every write on an unverified program with POSITION_UNVERIFIED', async () => {
    await setVerified(programA, false);
    const token = tokenFor(organisationA, 'capacity:write');

    const reserve = await request(app.getHttpServer())
      .post(`/v1/programs/${programA}/reservations`)
      .set('Authorization', authorisation(token))
      .set('Idempotency-Key', 't092-reserve-a-1')
      .send({
        invoiceId: 'inv-t092-new',
        amount: { amountMinor: '100', currency: 'USD' },
      });
    expect(reserve.status).toBe(503);
    expect(reserve.body.code).toBe('POSITION_UNVERIFIED');

    const release = await request(app.getHttpServer())
      .post(`/v1/programs/${programA}/reservations/inv-t092-a/releases`)
      .set('Authorization', authorisation(token))
      .set('Idempotency-Key', 't092-release-a-1')
      .send({ amount: { amountMinor: '100', currency: 'USD' } });
    expect(release.status).toBe(503);
    expect(release.body.code).toBe('POSITION_UNVERIFIED');

    const cancellation = await request(app.getHttpServer())
      .post(`/v1/programs/${programA}/reservations/inv-t092-a/cancellation`)
      .set('Authorization', authorisation(token))
      .set('Idempotency-Key', 't092-cancel-a-1')
      .send({ reason: 'CANCELLED' });
    expect(cancellation.status).toBe(503);
    expect(cancellation.body.code).toBe('POSITION_UNVERIFIED');

    const verified = await request(app.getHttpServer())
      .post(`/v1/programs/${programB}/reservations`)
      .set('Authorization', authorisation(tokenFor(organisationB, 'capacity:write')))
      .set('Idempotency-Key', 't092-reserve-b-1')
      .send({
        invoiceId: 'inv-t092-b',
        amount: { amountMinor: '100', currency: 'USD' },
      });
    expect(verified.status).toBe(201);
    expect(await readVerified(programA)).toBe(false);
  });

  it('resolves ownership before the recovery flag and leaks no state', async () => {
    await setVerified(programB, false);

    const response = await request(app.getHttpServer())
      .post(`/v1/programs/${programB}/reservations`)
      .set('Authorization', authorisation(tokenFor(organisationA, 'capacity:write')))
      .set('Idempotency-Key', 't092-foreign-b-1')
      .send({
        invoiceId: 'inv-t092-foreign',
        amount: { amountMinor: '100', currency: 'USD' },
      });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
    expect(JSON.stringify(response.body)).not.toContain(programB);
  });

  it('flags a program whose ledger is ahead of its stream position', async () => {
    const missing = await insertProgram(owner, organisationA, {
      currency: 'USD',
      creditLimitMinor: LIMIT,
    });
    await owner.query(
      `INSERT INTO capacity_ledger_entry
         (program_id, sequence, delta_minor, component, cause, actor, correlation_id, occurred_at)
       VALUES ($1, 1, 500, 'TREASURY', 'TREASURY_EVENT', 'treasury', 't092', $2)`,
      [missing, new Date('2026-01-01T00:00:00.000Z')],
    );

    const consistentAt = new Date('2026-02-01T00:00:00.000Z');
    const consistent = await insertProgram(owner, organisationA, {
      currency: 'USD',
      creditLimitMinor: LIMIT,
    });
    await owner.query(
      `INSERT INTO capacity_ledger_entry
         (program_id, sequence, delta_minor, component, cause, actor, correlation_id, occurred_at)
       VALUES ($1, 1, 500, 'TREASURY', 'TREASURY_EVENT', 'treasury', 't092', $2)`,
      [consistent, consistentAt],
    );
    await owner.query(
      `INSERT INTO program_stream_position
         (program_id, topic, partition, "offset", updated_at)
       VALUES ($1, 'treasury.capacity.events', 0, 1, $2)`,
      [consistent, consistentAt],
    );

    const report = await detection.detect();

    expect(report.flagged).toContain(missing);
    expect(report.flagged).not.toContain(consistent);
    expect(await readVerified(missing)).toBe(false);
    expect(await readVerified(consistent)).toBe(true);
  });

  it('clears the flag when a fresh snapshot is applied', async () => {
    const programId = await insertProgram(owner, organisationA, {
      currency: 'USD',
      creditLimitMinor: LIMIT,
    });
    await setVerified(programId, false);

    const snapshot: ReconciliationSnapshot = {
      messageId: 'snap-t092-clear',
      programId,
      version: 1n,
      effectiveAt: new Date('2026-03-01T00:00:00.000Z'),
      correlationId: null,
      currency: 'USD',
      creditLimitMinor: BigInt(LIMIT),
      reservedMinor: 0n,
      acknowledgement: {
        kind: 'WATERMARK',
        reservationReferences: null,
        ingestedThrough: new Date('2026-02-01T00:00:00.000Z'),
      },
    };
    const coordinates: StreamCoordinates = {
      topic: 'treasury.capacity.snapshots',
      partition: 0,
      offset: '1',
    };

    await expect(
      harness.snapshotService.apply(snapshot, coordinates),
    ).resolves.toEqual({ kind: 'applied' });

    expect(await readVerified(programId)).toBe(true);
  });
});
