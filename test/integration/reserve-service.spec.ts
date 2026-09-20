import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../../src/config/data-source';
import {
  NORTHWIND_ORGANISATION_ID,
  NORTHWIND_USD_PROGRAM_ID,
} from '../../scripts/seed';
import { CachedRateProvider } from '../../src/fx/cached-rate.provider';
import { CapacityRefusal } from '../../src/capacity/domain/errors';
import { IdempotencyService } from '../../src/capacity/application/idempotency.service';
import {
  ReserveCommand,
  ReserveService,
} from '../../src/capacity/application/reserve.service';
import { ProgramRepository } from '../../src/capacity/infrastructure/repositories/program.repository';
import { UnitOfWork } from '../../src/capacity/infrastructure/unit-of-work';
import { StreamLagRegistry } from '../../src/shared/stream-lag';
import { PostgresFixture, startPostgres } from '../support/postgres-container';

jest.setTimeout(180_000);

interface LedgerRow {
  component: string;
  cause: string;
  delta_minor: string;
}

interface ReservationRow {
  reserved_minor: string;
  fx_rate: string | null;
  fx_rate_effective_at: Date | null;
  fx_rate_source: string | null;
}

describe('ReserveService', () => {
  let fixture: PostgresFixture;
  let ds: DataSource;
  let service: ReserveService;

  const organisationId = NORTHWIND_ORGANISATION_ID;
  const programId = NORTHWIND_USD_PROGRAM_ID;

  const command = (overrides: Partial<ReserveCommand>): ReserveCommand => ({
    organisationId,
    programId,
    requestId: 'key-default',
    invoiceId: 'inv-default',
    amountMinor: 1_000_00n,
    currency: 'USD',
    actor: organisationId,
    correlationId: 'corr-default',
    ...overrides,
  });

  const countLedger = async (): Promise<number> => {
    const rows = await ds.query<{ count: number }[]>(
      `SELECT COUNT(*)::int AS count FROM capacity_ledger_entry WHERE program_id = $1`,
      [programId],
    );
    return rows[0]?.count ?? -1;
  };

  const countRequestRecords = async (): Promise<number> => {
    const rows = await ds.query<{ count: number }[]>(
      `SELECT COUNT(*)::int AS count FROM request_record`,
    );
    return rows[0]?.count ?? -1;
  };

  const readReservation = async (invoiceId: string): Promise<ReservationRow> => {
    const rows = await ds.query<ReservationRow[]>(
      `SELECT reserved_minor::text AS reserved_minor, fx_rate::text AS fx_rate,
              fx_rate_effective_at, fx_rate_source
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

  const readLocalReserved = async (): Promise<string> => {
    const rows = await ds.query<{ local_reserved_minor: string }[]>(
      `SELECT local_reserved_minor::text AS local_reserved_minor FROM program WHERE id = $1`,
      [programId],
    );
    return rows[0]?.local_reserved_minor ?? '';
  };

  const resetProgram = async (): Promise<void> => {
    await ds.query(`DELETE FROM invoice_reservation WHERE program_id = $1`, [
      programId,
    ]);
    await ds.query(`DELETE FROM capacity_ledger_entry WHERE program_id = $1`, [
      programId,
    ]);
    await ds.query(`DELETE FROM request_record`);
    await ds.query(
      `UPDATE program
          SET local_reserved_minor = 0,
              treasury_reserved_minor = 0,
              next_sequence = 1,
              over_limit_since = NULL
        WHERE id = $1`,
      [programId],
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

    await ds.query(`INSERT INTO organisation (id, name) VALUES ($1, $2)`, [
      organisationId,
      'Northwind Trading',
    ]);
    await ds.query(
      `INSERT INTO program (id, organisation_id, currency, credit_limit_minor)
       VALUES ($1, $2, 'USD', $3)`,
      [programId, organisationId, 1_000_000_000],
    );
    await ds.query(
      `INSERT INTO fx_rate (base_currency, quote_currency, effective_at, rate, source)
       VALUES ('EUR', 'USD', to_timestamp(0), '1.0850000000', 'seed')`,
    );

    service = new ReserveService(
      new UnitOfWork(ds),
      new ProgramRepository(),
      new IdempotencyService(),
      new CachedRateProvider(ds),
      new StreamLagRegistry(),
    );
  });

  beforeEach(async () => {
    await resetProgram();
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.destroy();
    }
    await fixture?.stop();
  });

  it('applies a same-currency reservation as one local ledger entry', async () => {
    const outcome = await service.reserve(
      command({
        requestId: 'key-same',
        invoiceId: 'inv-same',
        amountMinor: 1_000_00n,
        currency: 'USD',
      }),
    );

    expect(outcome.created).toBe(true);

    const reservation = await readReservation('inv-same');
    expect(reservation.fx_rate).toBeNull();

    const entries = await ds.query<LedgerRow[]>(
      `SELECT component, cause, delta_minor::text AS delta_minor
         FROM capacity_ledger_entry WHERE program_id = $1`,
      [programId],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      component: 'LOCAL',
      cause: 'RESERVATION',
      delta_minor: '100000',
    });
    expect(await readLocalReserved()).toBe('100000');
  });

  it('denormalises the FX rate for a cross-currency reservation', async () => {
    await service.reserve(
      command({
        requestId: 'key-fx',
        invoiceId: 'inv-fx',
        amountMinor: 1_000_000_00n,
        currency: 'EUR',
      }),
    );

    const reservation = await readReservation('inv-fx');
    expect(reservation.reserved_minor).toBe('108500000');
    expect(reservation.fx_rate).toBe('1.0850000000');
    expect(reservation.fx_rate_effective_at).not.toBeNull();
    expect(reservation.fx_rate_source).toBe('seed');
  });

  it('replays an identical request with a byte-identical body and no new ledger entry', async () => {
    const first = await service.reserve(
      command({ requestId: 'key-replay', invoiceId: 'inv-replay' }),
    );
    const ledgerAfterFirst = await countLedger();

    const second = await service.reserve(
      command({ requestId: 'key-replay', invoiceId: 'inv-replay' }),
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.body).toEqual(first.body);
    expect(await countLedger()).toBe(ledgerAfterFirst);
  });

  it('refuses the same key with a different amount as IDEMPOTENCY_CONFLICT', async () => {
    await service.reserve(
      command({ requestId: 'key-conflict', invoiceId: 'inv-conflict' }),
    );
    const ledgerAfterFirst = await countLedger();

    await expect(
      service.reserve(
        command({
          requestId: 'key-conflict',
          invoiceId: 'inv-conflict',
          amountMinor: 2_000_00n,
        }),
      ),
    ).rejects.toMatchObject({
      name: 'CapacityRefusal',
      code: 'IDEMPOTENCY_CONFLICT',
    });

    expect(await countLedger()).toBe(ledgerAfterFirst);
  });

  it('refuses a second reservation for the same invoice under a different key', async () => {
    await service.reserve(
      command({ requestId: 'key-dup-1', invoiceId: 'inv-dup' }),
    );

    const refusal = service.reserve(
      command({ requestId: 'key-dup-2', invoiceId: 'inv-dup' }),
    );
    await expect(refusal).rejects.toBeInstanceOf(CapacityRefusal);
    await expect(refusal).rejects.toMatchObject({ code: 'DUPLICATE_INVOICE' });
  });

  it('refuses a currency with no rate and writes nothing', async () => {
    const ledgerBefore = await countLedger();
    const recordsBefore = await countRequestRecords();

    await expect(
      service.reserve(
        command({
          requestId: 'key-gbp',
          invoiceId: 'inv-gbp',
          currency: 'GBP',
        }),
      ),
    ).rejects.toMatchObject({ code: 'FX_RATE_UNAVAILABLE' });

    expect(await countLedger()).toBe(ledgerBefore);
    expect(await countRequestRecords()).toBe(recordsBefore);
  });

  it('frees the idempotency key after a refusal', async () => {
    await expect(
      service.reserve(
        command({
          requestId: 'key-reuse',
          invoiceId: 'inv-reuse-failed',
          currency: 'GBP',
        }),
      ),
    ).rejects.toMatchObject({ code: 'FX_RATE_UNAVAILABLE' });

    const outcome = await service.reserve(
      command({ requestId: 'key-reuse', invoiceId: 'inv-reuse-ok' }),
    );

    expect(outcome.created).toBe(true);
  });
});
