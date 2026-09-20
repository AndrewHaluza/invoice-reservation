import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../../src/config/data-source';
import {
  MessageCommitter,
  TreasuryConsumer,
} from '../../src/treasury/consumer/treasury.consumer';
import { DlqPublisher, DlqRecord } from '../../src/treasury/dlq/dlq.publisher';
import { PostgresFixture, startPostgres } from '../support/postgres-container';
import {
  buildTreasuryHarness,
  insertOrganisation,
  insertProgram,
  snapshotMessage,
  TreasuryHarness,
} from '../support/treasury';

jest.setTimeout(180_000);

class RecordingDlq implements DlqPublisher {
  readonly records: DlqRecord[] = [];
  async publish(record: DlqRecord): Promise<void> {
    this.records.push(record);
  }
}

const testConfig = {
  get: (_key: string, fallback?: unknown) => fallback,
} as unknown as ConfigService;

interface ProgramRow {
  treasury_version: string;
  treasury_reserved_minor: string;
  local_reserved_minor: string;
  investigation_required: boolean;
}

interface LedgerRow {
  component: string;
  cause: string;
  delta_minor: string;
}

describe('Stale reconciliation snapshots (T080)', () => {
  let fixture: PostgresFixture;
  let ds: DataSource;
  let harness: TreasuryHarness;
  let programId: string;

  const readProgram = async (): Promise<ProgramRow> => {
    const rows = await ds.query<ProgramRow[]>(
      `SELECT treasury_version, treasury_reserved_minor::text AS treasury_reserved_minor,
              local_reserved_minor::text AS local_reserved_minor, investigation_required
         FROM program WHERE id = $1`,
      [programId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('program not found');
    return row;
  };

  const readLedger = (): Promise<LedgerRow[]> =>
    ds.query<LedgerRow[]>(
      `SELECT component, cause, delta_minor::text AS delta_minor
         FROM capacity_ledger_entry WHERE program_id = $1 ORDER BY sequence`,
      [programId],
    );

  beforeAll(async () => {
    fixture = await startPostgres();

    ds = new DataSource({
      ...dataSourceOptions,
      url: fixture.ownerUrl,
      entities: [],
    });
    await ds.initialize();
    await ds.runMigrations();

    const organisationId = await insertOrganisation(ds, 't080-org');
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

  it('ignores a snapshot older than the applied version and changes nothing', async () => {
    await expect(
      harness.snapshotHandler.handle(
        snapshotMessage({
          programId,
          messageId: 'snap-t080-first',
          version: 5,
          reservedMinor: '200000',
          creditLimitMinor: '1000000',
        }),
      ),
    ).resolves.toEqual({ kind: 'applied' });

    const afterApplied = await readProgram();
    expect(afterApplied.treasury_version).toBe('5');
    expect(afterApplied.treasury_reserved_minor).toBe('200000');
    const ledgerAfterApplied = await readLedger();
    expect(ledgerAfterApplied).toHaveLength(1);

    await expect(
      harness.snapshotHandler.handle(
        snapshotMessage({
          programId,
          messageId: 'snap-t080-stale',
          version: 4,
          reservedMinor: '999999',
          creditLimitMinor: '1000000',
        }),
      ),
    ).resolves.toEqual({ kind: 'skipped' });

    const afterStale = await readProgram();
    expect(afterStale.treasury_version).toBe('5');
    expect(afterStale.treasury_reserved_minor).toBe('200000');
    expect(afterStale.investigation_required).toBe(false);
    expect(await readLedger()).toHaveLength(ledgerAfterApplied.length);
  });

  it('quarantines an equal-version-differing-content snapshot as VERSION_CONFLICT', async () => {
    await expect(
      harness.snapshotHandler.handle(
        snapshotMessage({
          programId,
          messageId: 'snap-t080-conflict',
          version: 5,
          reservedMinor: '300000',
          creditLimitMinor: '1000000',
        }),
      ),
    ).resolves.toEqual({ kind: 'quarantined', reason: 'VERSION_CONFLICT' });

    const program = await readProgram();
    expect(program.treasury_reserved_minor).toBe('200000');
    expect(program.treasury_version).toBe('5');

    const processed = await ds.query<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM processed_message WHERE message_id = $1`,
      ['snap-t080-conflict'],
    );
    expect(processed[0]?.count).toBe(0);
  });

  it('advances the applied-version marker on a zero-delta snapshot while writing no entry', async () => {
    const before = await readLedger();

    await expect(
      harness.snapshotHandler.handle(
        snapshotMessage({
          programId,
          messageId: 'snap-t080-zero',
          version: 6,
          reservedMinor: '200000',
          creditLimitMinor: '1000000',
        }),
      ),
    ).resolves.toEqual({ kind: 'applied' });

    const program = await readProgram();
    expect(program.treasury_version).toBe('6');
    expect(program.treasury_reserved_minor).toBe('200000');
    expect(await readLedger()).toHaveLength(before.length);
  });

  it('applies a snapshot delivered through the consumer, proving the topic routing', async () => {
    const dlq = new RecordingDlq();
    const consumer = new TreasuryConsumer(
      harness.handler,
      harness.snapshotHandler,
      dlq,
      { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      testConfig,
    );
    const committed: string[] = [];
    const committer: MessageCommitter = {
      commitOffset: async (message) => {
        committed.push(message.offset);
      },
    };

    await consumer.processMessage(
      snapshotMessage({
        programId,
        messageId: 'snap-t080-ingest',
        version: 7,
        reservedMinor: '300000',
        creditLimitMinor: '1000000',
      }),
      committer,
    );

    expect(dlq.records).toHaveLength(0);
    expect(committed).toEqual(['0']);

    const program = await readProgram();
    expect(program.treasury_version).toBe('7');
    expect(program.treasury_reserved_minor).toBe('300000');
  });
});
