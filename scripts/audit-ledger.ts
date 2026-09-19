import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/config/data-source';

// SC-004 / FR-019a. Replays every program's ledger and asserts each cached
// position component equals the sum of its ledger entries. It reports; it never
// self-corrects. A mismatch exits non-zero, naming the program, the component,
// the ledger sum and the cached value, so an operator — not this script —
// decides what the position should be.

const COMPONENTS = ['LOCAL', 'TREASURY', 'LIMIT'] as const;
type Component = (typeof COMPONENTS)[number];

interface ProgramPositionRow {
  id: string;
  local_reserved_minor: string;
  treasury_reserved_minor: string;
  credit_limit_minor: string;
}

interface ComponentSumRow {
  component: string;
  total: string;
}

const CACHED_COLUMN: Record<Component, keyof ProgramPositionRow> = {
  LOCAL: 'local_reserved_minor',
  TREASURY: 'treasury_reserved_minor',
  LIMIT: 'credit_limit_minor',
};

export interface LedgerMismatch {
  readonly programId: string;
  readonly component: Component;
  readonly ledgerSum: bigint;
  readonly cached: bigint;
}

export interface AuditResult {
  readonly programsChecked: number;
  readonly mismatch: LedgerMismatch | null;
}

export async function auditLedger(dataSource: DataSource): Promise<AuditResult> {
  const programs = await dataSource.query<ProgramPositionRow[]>(
    `SELECT id, local_reserved_minor, treasury_reserved_minor, credit_limit_minor
       FROM program
      ORDER BY id ASC`,
  );

  let programsChecked = 0;

  for (const program of programs) {
    const rows = await dataSource.query<ComponentSumRow[]>(
      `SELECT component, COALESCE(SUM(delta_minor), 0)::text AS total
         FROM capacity_ledger_entry
        WHERE program_id = $1
        GROUP BY component`,
      [program.id],
    );

    const sums: Record<Component, bigint> = {
      LOCAL: 0n,
      TREASURY: 0n,
      LIMIT: 0n,
    };
    for (const row of rows) {
      if (row.component === 'LOCAL' || row.component === 'TREASURY' || row.component === 'LIMIT') {
        sums[row.component] = BigInt(row.total);
      }
    }

    for (const component of COMPONENTS) {
      const cached = BigInt(program[CACHED_COLUMN[component]]);
      if (sums[component] !== cached) {
        return {
          programsChecked,
          mismatch: {
            programId: program.id,
            component,
            ledgerSum: sums[component],
            cached,
          },
        };
      }
    }

    programsChecked += 1;
  }

  return { programsChecked, mismatch: null };
}

async function main(): Promise<void> {
  const dataSource = new DataSource(dataSourceOptions);
  await dataSource.initialize();
  try {
    const result = await auditLedger(dataSource);

    if (result.mismatch !== null) {
      const { programId, component, ledgerSum, cached } = result.mismatch;
      process.stderr.write(
        `ledger mismatch program=${programId} component=${component} ` +
          `ledgerSum=${ledgerSum.toString()} cached=${cached.toString()}\n`,
      );
      process.exitCode = 1;
      return;
    }

    process.stdout.write(
      `ledger audit: ${result.programsChecked} program(s) reconciled\n`,
    );
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ledger audit failed: ${message}\n`);
    process.exitCode = 1;
  });
}
