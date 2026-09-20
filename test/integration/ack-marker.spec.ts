import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../../src/config/data-source';
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
  treasury_version: string;
}

interface ReservationRow {
  treasury_acknowledged: boolean;
  acknowledged_by_version: string | null;
}

describe('Snapshot acknowledgement marker (T082)', () => {
  let fixture: PostgresFixture;
  let ds: DataSource;
  let harness: TreasuryHarness;
  let organisationId: string;

  const readProgram = async (programId: string): Promise<ProgramRow> => {
    const rows = await ds.query<ProgramRow[]>(
      `SELECT treasury_reserved_minor::text AS treasury_reserved_minor,
              local_reserved_minor::text AS local_reserved_minor,
              treasury_version::text AS treasury_version
         FROM program WHERE id = $1`,
      [programId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('program not found');
    return row;
  };

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

    organisationId = await insertOrganisation(ds, 't082-org');
    harness = buildTreasuryHarness(ds);
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.destroy();
    }
    await fixture?.stop();
  });

  it('matches an EXPLICIT marker against treasury_reference', async () => {
    const programId = await insertProgram(ds, organisationId, {
      currency: 'USD',
      creditLimitMinor: LIMIT,
      localReservedMinor: 300_000,
    });
    await insertLocalReservation(ds, programId, {
      invoiceId: 'inv-ack-explicit',
      amountMinor: 300_000,
      treasuryReference: 'TRSY-ACK-X',
    });

    await expect(
      harness.snapshotHandler.handle(
        snapshotMessage({
          programId,
          messageId: 'snap-t082-explicit',
          version: 20,
          reservedMinor: '1000000',
          creditLimitMinor: String(LIMIT),
          acknowledgement: {
            kind: 'EXPLICIT',
            reservationIds: ['TRSY-ACK-X'],
          },
        }),
      ),
    ).resolves.toEqual({ kind: 'applied' });

    const reservation = await readReservation(programId, 'inv-ack-explicit');
    expect(reservation.treasury_acknowledged).toBe(true);
    expect(reservation.acknowledged_by_version).toBe('20');

    const program = await readProgram(programId);
    expect(program.treasury_reserved_minor).toBe('700000');
  });

  it('acknowledges only reservations confirmed at or before a WATERMARK', async () => {
    const programId = await insertProgram(ds, organisationId, {
      currency: 'USD',
      creditLimitMinor: LIMIT,
      localReservedMinor: 500_000,
    });
    await insertLocalReservation(ds, programId, {
      invoiceId: 'inv-ack-before',
      amountMinor: 300_000,
      treasuryReference: 'TRSY-ACK-BEFORE',
      confirmedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await insertLocalReservation(ds, programId, {
      invoiceId: 'inv-ack-after',
      amountMinor: 200_000,
      treasuryReference: 'TRSY-ACK-AFTER',
      confirmedAt: new Date('2026-06-01T00:00:00.000Z'),
    });

    await expect(
      harness.snapshotHandler.handle(
        snapshotMessage({
          programId,
          messageId: 'snap-t082-watermark',
          version: 21,
          reservedMinor: '1000000',
          creditLimitMinor: String(LIMIT),
          acknowledgement: {
            kind: 'WATERMARK',
            ingestedThrough: '2026-03-01T00:00:00.000Z',
          },
        }),
      ),
    ).resolves.toEqual({ kind: 'applied' });

    const before = await readReservation(programId, 'inv-ack-before');
    expect(before.treasury_acknowledged).toBe(true);
    expect(before.acknowledged_by_version).toBe('21');

    const after = await readReservation(programId, 'inv-ack-after');
    expect(after.treasury_acknowledged).toBe(false);

    const program = await readProgram(programId);
    expect(program.treasury_reserved_minor).toBe('700000');
  });

  it('applies the marker before the sums are computed', async () => {
    const programId = await insertProgram(ds, organisationId, {
      currency: 'USD',
      creditLimitMinor: LIMIT,
      localReservedMinor: 500_000,
    });
    await insertLocalReservation(ds, programId, {
      invoiceId: 'inv-ack-order',
      amountMinor: 500_000,
      treasuryReference: 'TRSY-ACK-ORDER',
    });

    await expect(
      harness.snapshotHandler.handle(
        snapshotMessage({
          programId,
          messageId: 'snap-t082-order',
          version: 22,
          reservedMinor: '1000000',
          creditLimitMinor: String(LIMIT),
          acknowledgement: {
            kind: 'EXPLICIT',
            reservationIds: ['TRSY-ACK-ORDER'],
          },
        }),
      ),
    ).resolves.toEqual({ kind: 'applied' });

    const program = await readProgram(programId);
    // Marker-first: target_treasury = 1_000_000 - 500_000 = 500_000.
    // Sums-first would have produced 1_000_000 instead.
    expect(program.treasury_reserved_minor).toBe('500000');
    expect(program.treasury_reserved_minor).not.toBe('1000000');

    const reservation = await readReservation(programId, 'inv-ack-order');
    expect(reservation.treasury_acknowledged).toBe(true);
    expect(reservation.acknowledged_by_version).toBe('22');
  });

  it('does not re-acknowledge a reservation at a version older than its acknowledged_by_version', async () => {
    const programId = await insertProgram(ds, organisationId, {
      currency: 'USD',
      creditLimitMinor: LIMIT,
      localReservedMinor: 500_000,
      // The program is behind a reservation that a higher-version snapshot has
      // already acknowledged: the ordering FR-011e exists to survive.
      treasuryVersion: 5,
    });
    await insertLocalReservation(ds, programId, {
      invoiceId: 'inv-ack-old',
      amountMinor: 300_000,
      treasuryReference: 'TRSY-ACK-OLD',
      acknowledgedByVersion: 7,
    });
    await insertLocalReservation(ds, programId, {
      invoiceId: 'inv-ack-new',
      amountMinor: 200_000,
      treasuryReference: 'TRSY-ACK-NEW',
    });

    await expect(
      harness.snapshotHandler.handle(
        snapshotMessage({
          programId,
          messageId: 'snap-t082-precedence',
          version: 6,
          reservedMinor: '1000000',
          creditLimitMinor: String(LIMIT),
          acknowledgement: {
            kind: 'EXPLICIT',
            reservationIds: ['TRSY-ACK-OLD', 'TRSY-ACK-NEW'],
          },
        }),
      ),
    ).resolves.toEqual({ kind: 'applied' });

    const oldReservation = await readReservation(programId, 'inv-ack-old');
    expect(oldReservation.acknowledged_by_version).toBe('7');
    expect(oldReservation.treasury_acknowledged).toBe(true);

    // The stale marker skips one reservation; the rest of the snapshot proceeds.
    const newReservation = await readReservation(programId, 'inv-ack-new');
    expect(newReservation.treasury_acknowledged).toBe(true);
    expect(newReservation.acknowledged_by_version).toBe('6');

    const program = await readProgram(programId);
    expect(program.treasury_version).toBe('6');
    // acked_local = 300_000 (already acknowledged) + 200_000 (newly) = 500_000;
    // reservedMinor is inclusive of both, so target_treasury = 500_000.
    expect(program.treasury_reserved_minor).toBe('500000');
  });
});
