import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../../src/config/data-source';
import { TreasuryConsumer, MessageCommitter } from '../../src/treasury/consumer/treasury.consumer';
import { DlqPublisher, DlqRecord } from '../../src/treasury/dlq/dlq.publisher';
import {
  PermanentTreasuryError,
  RetryPolicy,
} from '../../src/treasury/retry/failure-classifier';
import {
  CapacityEventHandler,
  HandleOutcome,
  InboundMessage,
} from '../../src/treasury/handlers/capacity-event.handler';
import { parseCapacityEvent } from '../../src/treasury/schemas/capacity-event.schema';
import { CapacityEvent } from '../../src/shared/treasury/capacity-event';
import { PostgresFixture, startPostgres } from '../support/postgres-container';
import {
  buildTreasuryHarness,
  capacityEventMessage,
  insertLocalReservation,
  insertOrganisation,
  insertProgram,
  snapshotMessage,
  TreasuryHarness,
} from '../support/treasury';

jest.setTimeout(180_000);

class RecordingDlqPublisher implements DlqPublisher {
  readonly records: DlqRecord[] = [];

  async publish(record: DlqRecord): Promise<void> {
    this.records.push(record);
  }
}

interface RecordingCommitter extends MessageCommitter {
  readonly committed: string[];
}

const committer = (): RecordingCommitter => {
  const committed: string[] = [];
  return {
    committed,
    commitOffset: async (m: InboundMessage) => {
      committed.push(m.offset);
    },
  };
};

const FAST_RETRY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 };
const PERMANENT_RETRY: RetryPolicy = {
  maxAttempts: 1,
  baseDelayMs: 1,
  maxDelayMs: 1,
};

const TEST_CONFIG = {
  get: (_key: string, fallback?: unknown) => fallback,
} as unknown as ConfigService;

describe('Treasury consumer DLQ (T071)', () => {
  let fixture: PostgresFixture;
  let ds: DataSource;
  let harness: TreasuryHarness;
  let programId: string;

  // The consumer routes by topic; snapshots go to the snapshot handler.
  const newConsumer = (
    handler: CapacityEventHandler,
    dlq: DlqPublisher,
    retry: RetryPolicy,
    config: ConfigService,
  ): TreasuryConsumer =>
    new TreasuryConsumer(handler, harness.snapshotHandler, dlq, retry, config);

  beforeAll(async () => {
    fixture = await startPostgres();

    ds = new DataSource({
      ...dataSourceOptions,
      url: fixture.ownerUrl,
      entities: [],
    });
    await ds.initialize();
    await ds.runMigrations();

    const organisationId = await insertOrganisation(ds, 't071-org');

    programId = await insertProgram(ds, organisationId, {
      currency: 'USD',
      creditLimitMinor: 1_000_000,
    });

    harness = buildTreasuryHarness(ds);
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.destroy();
    }
    await fixture?.stop();
  });

  it('quarantines an unparseable event as SCHEMA_INVALID', async () => {
    const dlq = new RecordingDlqPublisher();
    const c = committer();
    const consumer = newConsumer(
      harness.handler,
      dlq,
      FAST_RETRY,
      TEST_CONFIG,
    );
    const message: InboundMessage = {
      ...capacityEventMessage({ programId, messageId: 'msg-schema-0001' }),
      value: Buffer.from('{ not valid json'),
    };

    await consumer.processMessage(message, c);

    expect(dlq.records).toHaveLength(1);
    expect(dlq.records[0]?.reason).toBe('SCHEMA_INVALID');
    expect(c.committed).toHaveLength(1);
  });

  it('quarantines an event for an unknown program as UNKNOWN_PROGRAM', async () => {
    const dlq = new RecordingDlqPublisher();
    const c = committer();
    const consumer = newConsumer(
      harness.handler,
      dlq,
      FAST_RETRY,
      TEST_CONFIG,
    );
    const message = capacityEventMessage({
      programId: randomUUID(),
      messageId: 'msg-unknown-0001',
    });

    await consumer.processMessage(message, c);

    expect(dlq.records).toHaveLength(1);
    expect(dlq.records[0]?.reason).toBe('UNKNOWN_PROGRAM');
    expect(c.committed).toHaveLength(1);
  });

  it('quarantines a currency mismatch as CURRENCY_MISMATCH', async () => {
    const dlq = new RecordingDlqPublisher();
    const c = committer();
    const consumer = newConsumer(
      harness.handler,
      dlq,
      FAST_RETRY,
      TEST_CONFIG,
    );
    const message = capacityEventMessage({
      programId,
      messageId: 'msg-currency-0001',
      currency: 'EUR',
    });

    await consumer.processMessage(message, c);

    expect(dlq.records).toHaveLength(1);
    expect(dlq.records[0]?.reason).toBe('CURRENCY_MISMATCH');
    expect(c.committed).toHaveLength(1);
  });

  it('quarantines a stale version as VERSION_CONFLICT', async () => {
    const first = capacityEventMessage({
      programId,
      messageId: 'msg-vc-1',
      version: 5,
      amountMinor: '100',
    });
    await expect(harness.handler.handle(first)).resolves.toEqual({
      kind: 'applied',
    });

    const dlq = new RecordingDlqPublisher();
    const c = committer();
    const consumer = newConsumer(
      harness.handler,
      dlq,
      FAST_RETRY,
      TEST_CONFIG,
    );
    const second = capacityEventMessage({
      programId,
      messageId: 'msg-vc-2',
      version: 5,
      amountMinor: '200',
    });

    await consumer.processMessage(second, c);

    expect(dlq.records).toHaveLength(1);
    expect(dlq.records[0]?.reason).toBe('VERSION_CONFLICT');
    expect(c.committed).toHaveLength(1);
  });

  it('quarantines a permanent handler failure as HANDLER_FAILURE', async () => {
    const dlq = new RecordingDlqPublisher();
    const c = committer();
    const handler = {
      handle: async (): Promise<HandleOutcome> => {
        throw new PermanentTreasuryError('boom');
      },
    };
    const consumer = newConsumer(
      handler as unknown as CapacityEventHandler,
      dlq,
      PERMANENT_RETRY,
      TEST_CONFIG,
    );

    await consumer.processMessage(
      capacityEventMessage({ programId, messageId: 'msg-permanent-0001' }),
      c,
    );

    expect(dlq.records).toHaveLength(1);
    expect(dlq.records[0]?.reason).toBe('HANDLER_FAILURE');
    expect(c.committed).toHaveLength(1);
  });

  it('retries a transient lock timeout in place, never reaching the DLQ, and commits only after success', async () => {
    const lockTimeout = () =>
      Object.assign(new Error('canceling statement due to lock timeout'), {
        code: '55P03',
      });
    let calls = 0;
    const c = committer();
    const handler = {
      handle: async (): Promise<HandleOutcome> => {
        calls += 1;
        expect(c.committed).toHaveLength(0);
        if (calls <= 2) {
          throw lockTimeout();
        }
        return { kind: 'applied' } as const;
      },
    };
    const dlq = new RecordingDlqPublisher();
    const consumer = newConsumer(
      handler as unknown as CapacityEventHandler,
      dlq,
      FAST_RETRY,
      TEST_CONFIG,
    );

    await consumer.processMessage(
      capacityEventMessage({ programId, messageId: 'msg-transient-0001' }),
      c,
    );

    expect(calls).toBe(3);
    expect(dlq.records).toHaveLength(0);
    expect(c.committed).toHaveLength(1);
  });

  it('never quarantines a transient failure whose retry budget is exhausted, and never commits its offset', async () => {
    const poolExhausted = () =>
      Object.assign(new Error('too many connections'), { code: '53300' });
    const handler = {
      handle: async (): Promise<HandleOutcome> => {
        throw poolExhausted();
      },
    };
    const dlq = new RecordingDlqPublisher();
    const c = committer();
    const consumer = newConsumer(
      handler as unknown as CapacityEventHandler,
      dlq,
      FAST_RETRY,
      TEST_CONFIG,
    );

    await expect(
      consumer.processMessage(
        capacityEventMessage({
          programId,
          messageId: 'msg-transient-exhausted-0001',
        }),
        c,
      ),
    ).rejects.toThrow();

    expect(dlq.records).toHaveLength(0);
    expect(c.committed).toHaveLength(0);
  });

  it('detects a same-version content conflict inside the lock, not only in inspect', async () => {
    const coordinates = {
      topic: 'treasury.capacity.events',
      partition: 0,
      offset: '0',
    };
    const eventFor = (message: InboundMessage): CapacityEvent => {
      const parsed = parseCapacityEvent(message.value);
      if (!parsed.ok) {
        throw new Error('test event did not parse');
      }
      return parsed.event;
    };

    const first = capacityEventMessage({
      programId,
      messageId: 'msg-lock-vc-1',
      version: 7,
      amountMinor: '10',
    });
    await expect(
      harness.applyService.apply(eventFor(first), coordinates),
    ).resolves.toEqual({ kind: 'applied' });

    const second = capacityEventMessage({
      programId,
      messageId: 'msg-lock-vc-2',
      version: 7,
      amountMinor: '20',
    });
    await expect(
      harness.applyService.apply(eventFor(second), coordinates),
    ).resolves.toEqual({ kind: 'quarantined', reason: 'VERSION_CONFLICT' });
  });

  it('quarantines a snapshot with no acknowledgement marker as MISSING_ACK_MARKER', async () => {
    const dlq = new RecordingDlqPublisher();
    const c = committer();
    const consumer = newConsumer(
      harness.handler,
      dlq,
      FAST_RETRY,
      TEST_CONFIG,
    );
    const message = snapshotMessage({
      programId,
      messageId: 'msg-snap-noack-0001',
      version: 50,
      reservedMinor: '0',
      creditLimitMinor: '1000000',
      acknowledgement: null,
    });

    await consumer.processMessage(message, c);

    expect(dlq.records).toHaveLength(1);
    expect(dlq.records[0]?.reason).toBe('MISSING_ACK_MARKER');
    expect(c.committed).toHaveLength(1);
  });

  it('quarantines an implausible treasury correction as IMPLAUSIBLE_DELTA', async () => {
    const dlq = new RecordingDlqPublisher();
    const c = committer();
    const consumer = newConsumer(
      harness.handler,
      dlq,
      FAST_RETRY,
      TEST_CONFIG,
    );
    const message = snapshotMessage({
      programId,
      messageId: 'msg-snap-implausible-0001',
      version: 51,
      reservedMinor: '10000000',
      creditLimitMinor: '1000000',
    });

    await consumer.processMessage(message, c);

    expect(dlq.records).toHaveLength(1);
    expect(dlq.records[0]?.reason).toBe('IMPLAUSIBLE_DELTA');
    expect(c.committed).toHaveLength(1);
  });

  it('quarantines a self-contradicting snapshot as SNAPSHOT_INCONSISTENT', async () => {
    await insertLocalReservation(ds, programId, {
      invoiceId: 'inv-dlq-inconsistent',
      amountMinor: 500_000,
      treasuryReference: 'TRSY-DLQ-I',
    });

    const dlq = new RecordingDlqPublisher();
    const c = committer();
    const consumer = newConsumer(
      harness.handler,
      dlq,
      FAST_RETRY,
      TEST_CONFIG,
    );
    const message = snapshotMessage({
      programId,
      messageId: 'msg-snap-inconsistent-0001',
      version: 52,
      reservedMinor: '100000',
      creditLimitMinor: '1000000',
      acknowledgement: {
        kind: 'EXPLICIT',
        reservationIds: ['TRSY-DLQ-I'],
      },
    });

    await consumer.processMessage(message, c);

    expect(dlq.records).toHaveLength(1);
    expect(dlq.records[0]?.reason).toBe('SNAPSHOT_INCONSISTENT');
    expect(c.committed).toHaveLength(1);
  });
});
