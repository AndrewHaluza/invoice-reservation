import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { positionUnverifiedPrograms } from '../../observability/metrics';

export interface RecoveryDetectionReport {
  readonly flagged: ReadonlyArray<string>;
}

interface RecoveryRow {
  program_id: string;
  ledger_at: Date | null;
  position_at: Date | null;
}

@Injectable()
export class RecoveryDetectionService implements OnModuleInit {
  private readonly logger = new Logger(RecoveryDetectionService.name);

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    await this.detect();
  }

  // FR-019e. A program whose recorded stream position is older than its newest
  // treasury-applied ledger entry — or absent while such entries exist — was
  // restored from a ledger that is ahead of the position. It is flagged until a
  // fresh snapshot clears it.
  //
  // Only entries the stream applied (`actor = 'treasury'`) count. The seed also
  // writes a LIMIT_CHANGE entry, but it is local bootstrap data, not a message
  // whose offset the stream position should reflect; treating it as treasury
  // state would flag every freshly seeded program and refuse all writes.
  async detect(): Promise<RecoveryDetectionReport> {
    const rows = await this.dataSource.query<RecoveryRow[]>(
      `SELECT p.id AS program_id,
              (SELECT MAX(cle.occurred_at)
                 FROM capacity_ledger_entry cle
                WHERE cle.program_id = p.id
                  AND cle.actor = 'treasury'
                  AND cle.cause IN ('TREASURY_EVENT', 'LIMIT_CHANGE', 'RECONCILIATION_ADJUSTMENT')) AS ledger_at,
              (SELECT MAX(psp.updated_at)
                 FROM program_stream_position psp
                WHERE psp.program_id = p.id) AS position_at
         FROM program p
        WHERE p.position_verified = TRUE
        ORDER BY p.id ASC`,
    );

    const flagged: string[] = [];
    for (const row of rows) {
      if (row.ledger_at === null) {
        continue;
      }
      const ledgerAt = new Date(row.ledger_at);
      const positionAt = row.position_at === null ? null : new Date(row.position_at);
      if (positionAt !== null && positionAt >= ledgerAt) {
        continue;
      }

      await this.dataSource.query(
        `UPDATE program SET position_verified = FALSE WHERE id = $1`,
        [row.program_id],
      );
      flagged.push(row.program_id);
      this.logger.warn(
        `program ${row.program_id} held unverified: stream position is behind its newest treasury ledger entry; writes are refused until a fresh snapshot clears it`,
      );
    }

    positionUnverifiedPrograms.set(flagged.length);

    return { flagged };
  }
}
