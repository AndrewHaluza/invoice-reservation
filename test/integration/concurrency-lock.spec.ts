import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../../src/config/data-source';
import {
  ProgramNotFoundError,
  UnitOfWork,
} from '../../src/capacity/infrastructure/unit-of-work';
import { ProgramRepository } from '../../src/capacity/infrastructure/repositories/program.repository';
import { LedgerRepository } from '../../src/capacity/infrastructure/repositories/ledger.repository';
import { advancePosition } from '../../src/capacity/domain/position';
import { PendingLedgerEntry } from '../../src/capacity/domain/ledger-entry';
import { PostgresFixture, startPostgres } from '../support/postgres-container';

jest.setTimeout(180_000);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface ProgramRow {
  credit_limit_minor: string;
  local_reserved_minor: string;
  treasury_reserved_minor: string;
  next_sequence: string;
}

describe('concurrency lock', () => {
  let fixture: PostgresFixture;
  let ds: DataSource;
  let unitOfWork: UnitOfWork;
  let programs: ProgramRepository;
  let ledger: LedgerRepository;
  let programId: string;
  let otherProgramId: string;
  let invariantProgramId: string;

  const insertReturningId = async (
    sql: string,
    parameters: unknown[],
  ): Promise<string> => {
    const rows = await ds.query<{ id: string }[]>(sql, parameters);
    const row = rows[0];
    if (row === undefined) {
      throw new Error('expected the insert to return exactly one row');
    }
    return row.id;
  };

  const newOrganisation = (name: string): Promise<string> =>
    insertReturningId(`INSERT INTO organisation (name) VALUES ($1) RETURNING id`, [
      name,
    ]);

  const newProgram = (
    organisationId: string,
    creditLimitMinor: number,
  ): Promise<string> =>
    insertReturningId(
      `INSERT INTO program
        (organisation_id, currency, credit_limit_minor, local_reserved_minor, treasury_reserved_minor)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [organisationId, 'USD', creditLimitMinor, 0, 0],
    );

  const readProgram = async (id: string): Promise<ProgramRow> => {
    const rows = await ds.query<ProgramRow[]>(
      `SELECT credit_limit_minor, local_reserved_minor, treasury_reserved_minor, next_sequence
         FROM program WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`program ${id} not found`);
    }
    return row;
  };

  const countLedger = async (id: string): Promise<number> => {
    const rows = await ds.query<{ count: number }[]>(
      `SELECT COUNT(*)::int AS count FROM capacity_ledger_entry WHERE program_id = $1`,
      [id],
    );
    return rows[0]?.count ?? 0;
  };

  const pending = (
    component: 'LOCAL' | 'TREASURY' | 'LIMIT',
    deltaMinor: bigint,
    cause: PendingLedgerEntry['cause'],
  ): PendingLedgerEntry => ({
    deltaMinor,
    component,
    cause,
    originReference: null,
    actor: 'test',
    correlationId: 'corr-lock',
  });

  beforeAll(async () => {
    fixture = await startPostgres();

    ds = new DataSource({
      ...dataSourceOptions,
      url: fixture.ownerUrl,
      entities: [],
    });
    await ds.initialize();
    await ds.runMigrations();

    const organisationId = await newOrganisation('concurrency-lock');
    programId = await newProgram(organisationId, 1000);
    otherProgramId = await newProgram(organisationId, 1000);
    invariantProgramId = await newProgram(organisationId, 0);

    unitOfWork = new UnitOfWork(ds);
    programs = new ProgramRepository();
    ledger = new LedgerRepository();
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.destroy();
    }
    await fixture?.stop();
  });

  it('serializes two withProgramLock calls on the same program', async () => {
    const order: string[] = [];
    let signalAStarted: () => void = () => {};
    const aStarted = new Promise<void>((resolve) => {
      signalAStarted = resolve;
    });

    const a = unitOfWork.withProgramLock(programId, async () => {
      order.push('a-start');
      signalAStarted();
      await sleep(200);
      order.push('a-end');
    });

    await aStarted;

    const b = unitOfWork.withProgramLock(programId, async () => {
      order.push('b-start');
      await sleep(200);
      order.push('b-end');
    });

    await Promise.all([a, b]);

    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('does not block calls on different programs', async () => {
    const order: string[] = [];
    const started = Date.now();

    await Promise.all([
      unitOfWork.withProgramLock(programId, async () => {
        order.push('a-start');
        await sleep(200);
        order.push('a-end');
      }),
      unitOfWork.withProgramLock(otherProgramId, async () => {
        order.push('b-start');
        await sleep(200);
        order.push('b-end');
      }),
    ]);

    const elapsed = Date.now() - started;

    expect(order).toContain('a-start');
    expect(order).toContain('b-start');
    expect(elapsed).toBeLessThan(350);
  });

  it('rolls back persistAdvance when the surrounding transaction throws', async () => {
    const before = await readProgram(programId);
    const ledgerBefore = await countLedger(programId);

    await expect(
      unitOfWork.withProgramLock(programId, async ({ manager, program }) => {
        const result = advancePosition(
          programs.toPosition(program),
          [pending('LOCAL', 500n, 'RESERVATION')],
          new Date(),
        );
        await programs.persistAdvance(manager, programId, result, new Date());
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const after = await readProgram(programId);
    expect(after).toEqual(before);
    expect(await countLedger(programId)).toBe(ledgerBefore);
  });

  it('keeps sumByComponent equal to the program cache columns', async () => {
    const result = await unitOfWork.withProgramLock(
      invariantProgramId,
      async ({ manager, program }) => {
        const advanced = advancePosition(
          programs.toPosition(program),
          [
            pending('LIMIT', 500n, 'LIMIT_CHANGE'),
            pending('LOCAL', 300n, 'RESERVATION'),
            pending('TREASURY', 100n, 'TREASURY_EVENT'),
          ],
          new Date(),
        );
        await programs.persistAdvance(
          manager,
          invariantProgramId,
          advanced,
          new Date(),
        );
        return advanced;
      },
    );

    expect(result.entries).toHaveLength(3);

    const sums = await unitOfWork.withProgramLock(invariantProgramId, ({ manager }) =>
      ledger.sumByComponent(manager, invariantProgramId),
    );
    const row = await readProgram(invariantProgramId);

    expect(sums.LOCAL).toBe(BigInt(row.local_reserved_minor));
    expect(sums.TREASURY).toBe(BigInt(row.treasury_reserved_minor));
    expect(sums.LIMIT).toBe(BigInt(row.credit_limit_minor));
  });

  it('throws ProgramNotFoundError for an unknown id', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';

    await expect(
      unitOfWork.withProgramLock(missing, async () => undefined),
    ).rejects.toBeInstanceOf(ProgramNotFoundError);
  });
});
