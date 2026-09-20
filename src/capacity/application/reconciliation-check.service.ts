import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { investigationRequiredPrograms } from '../../observability/metrics';

export interface ReconciliationMismatch {
  readonly programId: string;
  readonly expected: bigint;
  readonly actual: bigint;
}

export interface ReconciliationReport {
  readonly programsChecked: number;
  readonly mismatches: ReadonlyArray<ReconciliationMismatch>;
}

interface ReconciliationRow {
  program_id: string;
  local_reserved_minor: string;
  active_outstanding: string;
}

@Injectable()
export class ReconciliationCheckService {
  constructor(private readonly dataSource: DataSource) {}

  // FR-019b / FR-019f / SC-004c. Compares each program's recorded LOCAL
  // component against the outstanding of its active reservations. On a
  // mismatch it flags the program for investigation and writes nothing else —
  // no position column is ever reassigned from this sweep.
  async check(): Promise<ReconciliationReport> {
    const rows = await this.dataSource.query<ReconciliationRow[]>(
      `SELECT p.id AS program_id,
              p.local_reserved_minor::text AS local_reserved_minor,
              COALESCE(SUM(r.outstanding_reserved_minor), 0)::text AS active_outstanding
         FROM program p
         LEFT JOIN invoice_reservation r
           ON r.program_id = p.id
          AND r.origin = 'LOCAL'
          AND r.status IN ('ACTIVE', 'PARTIALLY_RELEASED')
        GROUP BY p.id, p.local_reserved_minor
        ORDER BY p.id ASC`,
    );

    const mismatches: ReconciliationMismatch[] = [];

    for (const row of rows) {
      const expected = BigInt(row.active_outstanding);
      const actual = BigInt(row.local_reserved_minor);
      if (expected === actual) {
        continue;
      }

      mismatches.push({ programId: row.program_id, expected, actual });
      await this.dataSource.query(
        `UPDATE program
            SET investigation_required = TRUE
          WHERE id = $1
            AND investigation_required = FALSE`,
        [row.program_id],
      );
    }

    investigationRequiredPrograms.set(mismatches.length);

    return { programsChecked: rows.length, mismatches };
  }
}
