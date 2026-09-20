import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { AvailabilityService } from '../../src/capacity/application/availability.service';
import { ProgramRepository } from '../../src/capacity/infrastructure/repositories/program.repository';
import { dataSourceOptions } from '../../src/config/data-source';
import { StreamLagRegistry } from '../../src/shared/stream-lag';
import { PostgresFixture, startPostgres } from '../support/postgres-container';
import {
  buildTreasuryHarness,
  insertLocalReservation,
  insertOrganisation,
  insertProgram,
  snapshotMessage,
  TreasuryHarness,
} from '../support/treasury';

jest.setTimeout(180_000);

const LIMIT = 1_200_000_000;

interface ProgramRow {
  treasury_reserved_minor: string;
  local_reserved_minor: string;
  credit_limit_minor: string;
  over_limit_since: Date | null;
  investigation_required: boolean;
  treasury_effective_at: Date | null;
  treasury_applied_effective_at: Date | null;
}

interface LedgerRow {
  component: string;
  cause: string;
  delta_minor: string;
}

interface ReservationRow {
  treasury_acknowledged: boolean;
  acknowledged_by_version: string | null;
}

describe('Snapshot decomposition (T081)', () => {
  let fixture: PostgresFixture;
  let ds: DataSource;
  let harness: TreasuryHarness;
  let organisationId: string;

  const readProgram = async (programId: string): Promise<ProgramRow> => {
    const rows = await ds.query<ProgramRow[]>(
      `SELECT treasury_reserved_minor::text AS treasury_reserved_minor,
              local_reserved_minor::text AS local_reserved_minor,
              credit_limit_minor::text AS credit_limit_minor,
              over_limit_since,
              investigation_required,
              treasury_effective_at,
              treasury_applied_effective_at
         FROM program WHERE id = $1`,
      [programId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('program not found');
    return row;
  };

  const readAdjustments = (programId: string): Promise<LedgerRow[]> =>
    ds.query<LedgerRow[]>(
      `SELECT component, cause, delta_minor::text AS delta_minor
         FROM capacity_ledger_entry
        WHERE program_id = $1 AND cause = 'RECONCILIATION_ADJUSTMENT'
        ORDER BY sequence`,
      [programId],
    );

  const readReservation = async (
    programId: string,
    invoiceId: string,
  ): Promise<ReservationRow> => {
    const rows = await ds.query<ReservationRow[]>(
      `SELECT treasury_acknowledged,
              acknowledged_by_version::text AS acknowledged_by_version
         FROM invoice_reservation
        WHERE program_id = $1 AND invoice_id = $2`,
      [programId, invoiceId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('reservation not found');
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

    organisationId = await insertOrganisation(ds, 't081-org');
    harness = buildTreasuryHarness(ds);
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.destroy();
    }
    await fixture?.stop();
  });

  it('adds a locally reserved amount on top of an unacknowledged snapshot', async () => {
    const programId = await insertProgram(ds, organisationId, {
      currency: 'USD',
      creditLimitMinor: LIMIT,
      localReservedMinor: 500_000,
    });
    await insertLocalReservation(ds, programId, {
      invoiceId: 'inv-dec-unacked',
      amountMinor: 500_000,
      treasuryReference: 'TRSY-DEC-U',
      confirmedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await expect(
      harness.snapshotHandler.handle(
        snapshotMessage({
          programId,
          messageId: 'snap-t081-unacked',
          version: 10,
          reservedMinor: '3500000',
          creditLimitMinor: String(LIMIT),
          acknowledgement: {
            kind: 'WATERMARK',
            ingestedThrough: '2025-12-31T00:00:00.000Z',
          },
        }),
      ),
    ).resolves.toEqual({ kind: 'applied' });

    const program = await readProgram(programId);
    expect(program.treasury_reserved_minor).toBe('3500000');
    expect(program.local_reserved_minor).toBe('500000');
    expect(
      BigInt(program.treasury_reserved_minor) +
        BigInt(program.local_reserved_minor),
    ).toBe(4_000_000n);

    expect(program.treasury_applied_effective_at).toEqual(
      program.treasury_effective_at,
    );

    const adjustments = await readAdjustments(programId);
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]).toEqual({
      component: 'TREASURY',
      cause: 'RECONCILIATION_ADJUSTMENT',
      delta_minor: '3500000',
    });
    expect(
      adjustments.some((entry) => entry.component === 'LOCAL'),
    ).toBe(false);

    const reservation = await readReservation(programId, 'inv-dec-unacked');
    expect(reservation.treasury_acknowledged).toBe(false);
  });

  it('quarantines SNAPSHOT_INCONSISTENT when the marker acknowledges more than reservedMinor', async () => {
    const programId = await insertProgram(ds, organisationId, {
      currency: 'USD',
      creditLimitMinor: LIMIT,
      localReservedMinor: 500_000,
    });
    await insertLocalReservation(ds, programId, {
      invoiceId: 'inv-dec-inconsistent',
      amountMinor: 500_000,
      treasuryReference: 'TRSY-DEC-I',
    });

    await expect(
      harness.snapshotHandler.handle(
        snapshotMessage({
          programId,
          messageId: 'snap-t081-inconsistent',
          version: 11,
          reservedMinor: '100000',
          creditLimitMinor: String(LIMIT),
          acknowledgement: {
            kind: 'EXPLICIT',
            reservationIds: ['TRSY-DEC-I'],
          },
        }),
      ),
    ).resolves.toEqual({
      kind: 'quarantined',
      reason: 'SNAPSHOT_INCONSISTENT',
    });

    const program = await readProgram(programId);
    expect(program.treasury_reserved_minor).toBe('0');
    expect(program.local_reserved_minor).toBe('500000');
    expect(await readAdjustments(programId)).toHaveLength(0);

    // No negative TREASURY entry may exist.
    const negativeTreasury = await ds.query<{ count: number }[]>(
      `SELECT count(*)::int AS count
         FROM capacity_ledger_entry
        WHERE program_id = $1 AND component = 'TREASURY' AND delta_minor < 0`,
      [programId],
    );
    expect(negativeTreasury[0]?.count).toBe(0);

    const acknowledgements = await ds.query<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM snapshot_acknowledgement WHERE program_id = $1`,
      [programId],
    );
    expect(acknowledgements[0]?.count).toBe(0);

    const reservation = await readReservation(programId, 'inv-dec-inconsistent');
    expect(reservation.treasury_acknowledged).toBe(false);
  });

  it('applies per-component corrections and flags a non-zero local correction', async () => {
    // local_reserved_minor is deliberately out of step with the reservation
    // sum: a local bookkeeping defect, not treasury drift.
    const programId = await insertProgram(ds, organisationId, {
      currency: 'USD',
      creditLimitMinor: LIMIT,
      localReservedMinor: 600_000,
    });
    await insertLocalReservation(ds, programId, {
      invoiceId: 'inv-dec-acked',
      amountMinor: 500_000,
      treasuryReference: 'TRSY-DEC-A',
      confirmedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await expect(
      harness.snapshotHandler.handle(
        snapshotMessage({
          programId,
          messageId: 'snap-t081-acked',
          version: 12,
          reservedMinor: '1000000',
          creditLimitMinor: String(LIMIT),
          acknowledgement: {
            kind: 'WATERMARK',
            ingestedThrough: '2026-06-01T00:00:00.000Z',
          },
        }),
      ),
    ).resolves.toEqual({ kind: 'applied' });

    const program = await readProgram(programId);
    // target_treasury = 1000000 - acked_local(500000) = 500000 (non-negative).
    expect(program.treasury_reserved_minor).toBe('500000');
    // target_local = local_total(500000); delta_local = -100000 is applied.
    expect(program.local_reserved_minor).toBe('500000');
    expect(program.investigation_required).toBe(true);

    const adjustments = await readAdjustments(programId);
    expect(adjustments).toHaveLength(2);
    const byComponent = Object.fromEntries(
      adjustments.map((entry) => [entry.component, entry.delta_minor]),
    );
    expect(byComponent).toEqual({ TREASURY: '500000', LOCAL: '-100000' });
    // No single blended entry: the treasury correction and the local correction
    // are separate entries, and the treasury one is not negative.
    expect(adjustments.map((entry) => entry.component).sort()).toEqual([
      'LOCAL',
      'TREASURY',
    ]);
    expect(
      BigInt(byComponent.TREASURY ?? '-1'),
    ).toBeGreaterThanOrEqual(0n);

    const reservation = await readReservation(programId, 'inv-dec-acked');
    expect(reservation.treasury_acknowledged).toBe(true);
    expect(reservation.acknowledged_by_version).toBe('12');
  });

  it('applies a local correction upward even when it goes over a reduced limit', async () => {
    // The cached LOCAL total under-counts the reservations, and treasury cuts
    // the limit below the corrected total in the same snapshot. Over-limit is
    // tolerated: the correction is applied and the program is flagged, not
    // aborted by the reservation-path trigger.
    const programId = await insertProgram(ds, organisationId, {
      currency: 'USD',
      creditLimitMinor: LIMIT,
      localReservedMinor: 8_000_000,
    });
    await insertLocalReservation(ds, programId, {
      invoiceId: 'inv-dec-local-up',
      amountMinor: 9_000_000,
      treasuryReference: 'TRSY-DEC-UP',
    });

    await expect(
      harness.snapshotHandler.handle(
        snapshotMessage({
          programId,
          messageId: 'snap-t081-local-up',
          version: 13,
          reservedMinor: '0',
          creditLimitMinor: '5000000',
        }),
      ),
    ).resolves.toEqual({ kind: 'applied' });

    const program = await readProgram(programId);
    expect(program.local_reserved_minor).toBe('9000000');
    expect(program.credit_limit_minor).toBe('5000000');
    expect(program.investigation_required).toBe(true);
    expect(program.over_limit_since).not.toBeNull();

    const adjustments = await readAdjustments(programId);
    const byComponent = Object.fromEntries(
      adjustments.map((entry) => [entry.component, entry.delta_minor]),
    );
    expect(byComponent).toEqual({
      LOCAL: '1000000',
      LIMIT: '-1195000000',
    });

    const onset = await ds.query<{ count: number }[]>(
      `SELECT count(*)::int AS count
         FROM capacity_ledger_entry
        WHERE program_id = $1 AND cause = 'OVER_LIMIT_ONSET'`,
      [programId],
    );
    expect(onset[0]?.count).toBe(1);
  });

  it('reports reconciliationPending when a WATERMARK acknowledgement is newer than a pending EXPLICIT one', async () => {
    const programId = await insertProgram(ds, organisationId, {
      currency: 'USD',
      creditLimitMinor: LIMIT,
      localReservedMinor: 500_000,
    });
    await insertLocalReservation(ds, programId, {
      invoiceId: 'inv-dec-recon-pending',
      amountMinor: 500_000,
      treasuryReference: 'TRSY-DEC-RP',
      confirmedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await expect(
      harness.snapshotHandler.handle(
        snapshotMessage({
          programId,
          messageId: 'snap-t081-recon-explicit',
          version: 30,
          reservedMinor: '500000',
          creditLimitMinor: String(LIMIT),
          acknowledgement: {
            kind: 'EXPLICIT',
            reservationIds: ['TRSY-DEC-RP'],
          },
        }),
      ),
    ).resolves.toEqual({ kind: 'applied' });

    await ds.query(
      `UPDATE invoice_reservation
          SET status = 'FULLY_RELEASED', updated_at = now()
        WHERE program_id = $1 AND invoice_id = $2`,
      [programId, 'inv-dec-recon-pending'],
    );

    await expect(
      harness.snapshotHandler.handle(
        snapshotMessage({
          programId,
          messageId: 'snap-t081-recon-watermark',
          version: 31,
          reservedMinor: '500000',
          creditLimitMinor: String(LIMIT),
          acknowledgement: {
            kind: 'WATERMARK',
            ingestedThrough: '2026-06-01T00:00:00.000Z',
          },
        }),
      ),
    ).resolves.toEqual({ kind: 'applied' });

    const availability = new AvailabilityService(
      ds,
      new ProgramRepository(),
      new StreamLagRegistry(),
    );
    const body = await availability.forProgram(programId);
    expect(body.reconciliationPending).toBe(true);
  });
});
