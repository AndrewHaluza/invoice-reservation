import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/config/data-source';
import { ReconciliationCheckService } from '../src/capacity/application/reconciliation-check.service';

// FR-019b / FR-019f / SC-004c. Manual sweep of the same check the scheduler runs
// in-process: each program's recorded LOCAL component is compared against the
// outstanding of its active reservations. It reports; it never self-corrects —
// a mismatch only flags the program for investigation. Any mismatch exits
// non-zero, naming the program, the expected and the recorded value, so an
// operator — not this script — decides what the position should be.

async function main(): Promise<void> {
  const dataSource = new DataSource(dataSourceOptions);
  await dataSource.initialize();
  try {
    const service = new ReconciliationCheckService(dataSource);
    const report = await service.check();

    if (report.mismatches.length > 0) {
      for (const { programId, expected, actual } of report.mismatches) {
        process.stderr.write(
          `reconciliation mismatch program=${programId} ` +
            `expected=${expected.toString()} actual=${actual.toString()}\n`,
        );
      }
      process.exitCode = 1;
      return;
    }

    process.stdout.write(
      `reconciliation check: ${report.programsChecked} program(s) verified\n`,
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
    process.stderr.write(`reconciliation check failed: ${message}\n`);
    process.exitCode = 1;
  });
}
