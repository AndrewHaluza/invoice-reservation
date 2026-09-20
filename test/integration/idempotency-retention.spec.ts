import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import {
  IdempotencyService,
  RequestIdentity,
  reserveFingerprint,
} from '../../src/capacity/application/idempotency.service';
import { RequestRetentionJob } from '../../src/capacity/application/request-retention.job';
import { dataSourceOptions } from '../../src/config/data-source';
import { PostgresFixture, startPostgres } from '../support/postgres-container';
import { insertOrganisation, insertProgram } from '../support/treasury';

jest.setTimeout(180_000);

const DAY_MS = 24 * 60 * 60 * 1000;

const AGED_COMPLETE_ID = 'retention-aged-complete';
const AGED_PENDING_ID = 'retention-aged-pending';
const FRESH_COMPLETE_ID = 'retention-fresh-complete';

const AGED_OUTCOME: Record<string, unknown> = {
  kind: 'reserved',
  reservationId: 'res-aged',
};
const FRESH_OUTCOME: Record<string, unknown> = {
  kind: 'reserved',
  reservationId: 'res-fresh',
};

interface RequestRecordRow {
  state: 'PENDING' | 'COMPLETE' | 'EXPIRED';
  outcome: Record<string, unknown> | null;
  content_fingerprint: string;
}

function schedulerRegistryStub(): SchedulerRegistry {
  return {
    addInterval: jest.fn(),
    deleteInterval: jest.fn(),
  } as unknown as SchedulerRegistry;
}

describe('Request-record retention sweep (FR-006b/FR-006c)', () => {
  let fixture: PostgresFixture;
  let ds: DataSource;
  let job: RequestRetentionJob;

  let organisationId: string;
  let agedFingerprint: string;
  let pendingFingerprint: string;
  let freshFingerprint: string;
  let affected = -1;

  const read = async (requestId: string): Promise<RequestRecordRow> => {
    const rows = await ds.query<RequestRecordRow[]>(
      `SELECT state, outcome, content_fingerprint
         FROM request_record
        WHERE organisation_id = $1 AND request_id = $2`,
      [organisationId, requestId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`expected request_record row ${requestId} to exist`);
    }
    return row;
  };

  const insertRecord = async (options: {
    requestId: string;
    fingerprint: string;
    state: 'PENDING' | 'COMPLETE';
    outcome: Record<string, unknown> | null;
    recordedAt: Date;
  }): Promise<void> => {
    await ds.query(
      `INSERT INTO request_record
         (organisation_id, request_id, operation, content_fingerprint, state, outcome, recorded_at)
       VALUES ($1, $2, 'RESERVE', $3, $4, $5::jsonb, $6)`,
      [
        organisationId,
        options.requestId,
        options.fingerprint,
        options.state,
        options.outcome === null ? null : JSON.stringify(options.outcome),
        options.recordedAt,
      ],
    );
  };

  beforeAll(async () => {
    fixture = await startPostgres();

    ds = new DataSource({
      ...dataSourceOptions,
      url: fixture.ownerUrl,
      entities: [],
    });
    await ds.initialize();
    await ds.runMigrations();

    organisationId = await insertOrganisation(ds, 'retention-org');
    const programId = await insertProgram(ds, organisationId, {
      currency: 'USD',
      creditLimitMinor: 1_000_000,
    });

    agedFingerprint = reserveFingerprint({
      programId,
      invoiceId: 'inv-retention-aged',
      amountMinor: '1000',
      currency: 'USD',
    });
    pendingFingerprint = reserveFingerprint({
      programId,
      invoiceId: 'inv-retention-pending',
      amountMinor: '1000',
      currency: 'USD',
    });
    freshFingerprint = reserveFingerprint({
      programId,
      invoiceId: 'inv-retention-fresh',
      amountMinor: '1000',
      currency: 'USD',
    });

    const now = Date.now();
    const agedAt = new Date(now - 31 * DAY_MS);
    const freshAt = new Date(now - 1 * DAY_MS);

    await insertRecord({
      requestId: AGED_COMPLETE_ID,
      fingerprint: agedFingerprint,
      state: 'COMPLETE',
      outcome: AGED_OUTCOME,
      recordedAt: agedAt,
    });
    await insertRecord({
      requestId: AGED_PENDING_ID,
      fingerprint: pendingFingerprint,
      state: 'PENDING',
      outcome: null,
      recordedAt: agedAt,
    });
    await insertRecord({
      requestId: FRESH_COMPLETE_ID,
      fingerprint: freshFingerprint,
      state: 'COMPLETE',
      outcome: FRESH_OUTCOME,
      recordedAt: freshAt,
    });

    job = new RequestRetentionJob(
      ds,
      schedulerRegistryStub(),
      new ConfigService({ REQUEST_RETENTION_DAYS: 30 }),
    );

    affected = await job.sweep();
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.destroy();
    }
    await fixture?.stop();
  });

  it('expires the aged COMPLETE row and leaves PENDING and fresh COMPLETE rows untouched', async () => {
    expect(affected).toBe(1);

    const aged = await read(AGED_COMPLETE_ID);
    expect(aged.state).toBe('EXPIRED');
    expect(aged.outcome).toBeNull();
    expect(aged.content_fingerprint).toBe(agedFingerprint);

    const agedPending = await read(AGED_PENDING_ID);
    expect(agedPending.state).toBe('PENDING');
    expect(agedPending.outcome).toBeNull();
    expect(agedPending.content_fingerprint).toBe(pendingFingerprint);

    const fresh = await read(FRESH_COMPLETE_ID);
    expect(fresh.state).toBe('COMPLETE');
    expect(fresh.outcome).toEqual(FRESH_OUTCOME);
    expect(fresh.content_fingerprint).toBe(freshFingerprint);

    const counts = await ds.query<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count FROM request_record`,
    );
    expect(counts[0]?.count).toBe('3');
  });

  it('answers a reused aged identifier IDEMPOTENCY_EXPIRED, never as new or conflict', async () => {
    const service = new IdempotencyService();
    const identity: RequestIdentity = {
      organisationId,
      requestId: AGED_COMPLETE_ID,
      operation: 'RESERVE',
      fingerprint: agedFingerprint,
    };

    await expect(
      service.begin(ds.manager, identity, new Date()),
    ).resolves.toEqual({ kind: 'refused', code: 'IDEMPOTENCY_EXPIRED' });

    await expect(
      service.begin(
        ds.manager,
        { ...identity, fingerprint: 'different-content' },
        new Date(),
      ),
    ).resolves.toEqual({ kind: 'refused', code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('leaves an over-age PENDING row untouched and warns', async () => {
    const logger = (
      job as unknown as { logger: { warn: (message: string) => void } }
    ).logger;
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    try {
      const stuckAffected = await job.sweep();

      expect(stuckAffected).toBe(0);
      expect(warn).toHaveBeenCalledWith(
        '1 request_record row(s) have been PENDING since before the retention cutoff; a writer crashed mid-request and the key cannot be replayed or reused',
      );

      const agedPending = await read(AGED_PENDING_ID);
      expect(agedPending.state).toBe('PENDING');
      expect(agedPending.outcome).toBeNull();
      expect(agedPending.content_fingerprint).toBe(pendingFingerprint);
    } finally {
      warn.mockRestore();
    }
  });
});
