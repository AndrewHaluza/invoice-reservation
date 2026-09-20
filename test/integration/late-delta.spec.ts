import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../../src/config/data-source';
import { PostgresFixture, startPostgres } from '../support/postgres-container';
import {
  buildTreasuryHarness,
  capacityEventMessage,
  insertOrganisation,
  insertProgram,
  TreasuryHarness,
} from '../support/treasury';

jest.setTimeout(180_000);

describe('Late capacity delta (T069)', () => {
  let fixture: PostgresFixture;
  let ds: DataSource;
  let harness: TreasuryHarness;
  let organisationId: string;
  let programId: string;

  interface AppliedTimeRow {
    treasury_applied_effective_at: Date | null;
    treasury_effective_at: Date | null;
  }

  const readAppliedEffectiveTime = async (
    id: string,
  ): Promise<AppliedTimeRow> => {
    const rows = await ds.query<AppliedTimeRow[]>(
      `SELECT treasury_applied_effective_at, treasury_effective_at
         FROM program WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('program not found');
    return row;
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

    organisationId = await insertOrganisation(ds, 't069-org');

    programId = await insertProgram(ds, organisationId, {
      currency: 'USD',
      creditLimitMinor: 1_000_000,
      treasuryVersion: 10,
      treasuryEffectiveAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    harness = buildTreasuryHarness(ds);
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.destroy();
    }
    await fixture?.stop();
  });

  it('applies an incremental event whose version is below the applied snapshot version, exactly once', async () => {
    const messageId = 'msg-late-delta-0001';
    const message = capacityEventMessage({
      programId,
      messageId,
      version: 3,
      amountMinor: '250',
      currency: 'USD',
      type: 'RESERVATION_BOOKED',
      effectiveAt: '2026-01-02T00:00:00.000Z',
    });

    // The handler returning `applied` (not `quarantined`) is how this harness
    // expresses the absence of a quarantine/DLQ outcome. The DLQ itself is the
    // consumer's concern and is asserted in dlq.spec.ts; no consumer runs here.
    await expect(harness.handler.handle(message)).resolves.toEqual({
      kind: 'applied',
    });

    const position = await ds.query<{ treasury_reserved_minor: string }[]>(
      `SELECT treasury_reserved_minor FROM program WHERE id = $1`,
      [programId],
    );
    expect(position[0]?.treasury_reserved_minor).toBe('250');

    const ledger = await ds.query<{ count: string }[]>(
      `SELECT count(*) FROM capacity_ledger_entry WHERE program_id = $1`,
      [programId],
    );
    expect(ledger[0]?.count).toBe('1');

    const processed = await ds.query<{ count: string }[]>(
      `SELECT count(*) FROM processed_message WHERE message_id = $1`,
      [messageId],
    );
    expect(processed[0]?.count).toBe('1');

    const snapshot = await ds.query<{ treasury_version: string }[]>(
      `SELECT treasury_version FROM program WHERE id = $1`,
      [programId],
    );
    expect(snapshot[0]?.treasury_version).toBe('10');
  });

  it('advances the applied effective time', async () => {
    const appliedProgramId = await insertProgram(ds, organisationId, {
      currency: 'USD',
      creditLimitMinor: 1_000_000,
    });
    const effectiveAt = '2026-03-01T12:00:00.000Z';

    await expect(
      harness.handler.handle(
        capacityEventMessage({
          programId: appliedProgramId,
          messageId: 'msg-applied-effective-0001',
          version: 1,
          effectiveAt,
          amountMinor: '250',
        }),
      ),
    ).resolves.toEqual({ kind: 'applied' });

    const applied = await readAppliedEffectiveTime(appliedProgramId);
    expect(applied.treasury_applied_effective_at?.toISOString()).toBe(
      effectiveAt,
    );
    expect(applied.treasury_effective_at).toBeNull();
  });

  it('does not move the applied effective time backwards', async () => {
    const appliedProgramId = await insertProgram(ds, organisationId, {
      currency: 'USD',
      creditLimitMinor: 1_000_000,
    });
    const later = '2026-03-01T12:00:00.000Z';
    const earlier = '2026-03-01T11:59:00.000Z';

    await expect(
      harness.handler.handle(
        capacityEventMessage({
          programId: appliedProgramId,
          messageId: 'msg-applied-time-later',
          version: 1,
          effectiveAt: later,
          amountMinor: '100',
        }),
      ),
    ).resolves.toEqual({ kind: 'applied' });

    // Still valid and still applied, but its effective time is behind: the
    // monotonic guard must keep the column at `later`.
    await expect(
      harness.handler.handle(
        capacityEventMessage({
          programId: appliedProgramId,
          messageId: 'msg-applied-time-earlier',
          version: 2,
          effectiveAt: earlier,
          amountMinor: '100',
        }),
      ),
    ).resolves.toEqual({ kind: 'applied' });

    const applied = await readAppliedEffectiveTime(appliedProgramId);
    expect(applied.treasury_applied_effective_at?.toISOString()).toBe(later);
  });
});
