// Single-program locking only. Any future transaction that must lock more than one
// program MUST acquire the locks in ORDER BY id ascending. Two transactions taking
// the same pair in opposite orders deadlock, and Postgres resolves that by aborting
// one of them — which surfaces to a caller as a failure caused by contention alone,
// exactly what SC-003a forbids.

import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { ProgramEntity } from './entities';

export class ProgramNotFoundError extends Error {
  constructor(programId: string) {
    super(`program not found: ${programId}`);
    this.name = 'ProgramNotFoundError';
  }
}

interface ProgramRow {
  id: string;
  organisation_id: string;
  currency: string;
  credit_limit_minor: string;
  local_reserved_minor: string;
  treasury_reserved_minor: string;
  next_sequence: string;
  over_limit_since: Date | null;
  treasury_version: string;
  treasury_effective_at: Date | null;
  position_changed_at: Date;
  investigation_required: boolean;
  position_verified: boolean;
}

function toProgramEntity(row: ProgramRow): ProgramEntity {
  const program = new ProgramEntity();
  program.id = row.id;
  program.organisationId = row.organisation_id;
  program.currency = row.currency;
  program.creditLimitMinor = BigInt(row.credit_limit_minor);
  program.localReservedMinor = BigInt(row.local_reserved_minor);
  program.treasuryReservedMinor = BigInt(row.treasury_reserved_minor);
  program.nextSequence = BigInt(row.next_sequence);
  program.overLimitSince = row.over_limit_since;
  program.treasuryVersion = BigInt(row.treasury_version);
  program.treasuryEffectiveAt = row.treasury_effective_at;
  program.positionChangedAt = row.position_changed_at;
  program.investigationRequired = row.investigation_required;
  program.positionVerified = row.position_verified;
  return program;
}

@Injectable()
export class UnitOfWork {
  constructor(private readonly dataSource: DataSource) {}

  withProgramLock<T>(
    programId: string,
    fn: (ctx: { manager: EntityManager; program: ProgramEntity }) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      const rows = await manager.query<ProgramRow[]>(
        'SELECT * FROM program WHERE id = $1 FOR UPDATE',
        [programId],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new ProgramNotFoundError(programId);
      }
      return fn({ manager, program: toProgramEntity(row) });
    });
  }
}
