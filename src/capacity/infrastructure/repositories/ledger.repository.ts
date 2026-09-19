import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

interface ComponentRow {
  component: string;
  total: string;
}

@Injectable()
export class LedgerRepository {
  async sumByComponent(
    manager: EntityManager,
    programId: string,
  ): Promise<{ LOCAL: bigint; TREASURY: bigint; LIMIT: bigint }> {
    const rows = await manager.query<ComponentRow[]>(
      `SELECT component, COALESCE(SUM(delta_minor), 0) AS total
         FROM capacity_ledger_entry
        WHERE program_id = $1
        GROUP BY component`,
      [programId],
    );

    const sums: { LOCAL: bigint; TREASURY: bigint; LIMIT: bigint } = {
      LOCAL: 0n,
      TREASURY: 0n,
      LIMIT: 0n,
    };

    for (const row of rows) {
      const total = BigInt(row.total);
      if (row.component === 'LOCAL') {
        sums.LOCAL = total;
      } else if (row.component === 'TREASURY') {
        sums.TREASURY = total;
      } else if (row.component === 'LIMIT') {
        sums.LIMIT = total;
      }
    }

    return sums;
  }
}
