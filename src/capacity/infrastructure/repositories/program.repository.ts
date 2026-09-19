import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { AdvanceResult } from '../../domain/position';
import { ProgramPosition } from '../../domain/program';
import { ProgramEntity } from '../entities';

@Injectable()
export class ProgramRepository {
  toPosition(entity: ProgramEntity): ProgramPosition {
    return {
      id: entity.id,
      currency: entity.currency,
      creditLimitMinor: entity.creditLimitMinor,
      localReservedMinor: entity.localReservedMinor,
      treasuryReservedMinor: entity.treasuryReservedMinor,
      nextSequence: entity.nextSequence,
      overLimitSince: entity.overLimitSince,
      investigationRequired: entity.investigationRequired,
      positionVerified: entity.positionVerified,
    };
  }

  // persistAdvance is the only method that writes the program row.
  async persistAdvance(
    manager: EntityManager,
    programId: string,
    result: AdvanceResult,
    now: Date,
  ): Promise<void> {
    if (result.entries.length > 0) {
      const values: unknown[] = [];
      const tuples = result.entries.map((entry, index) => {
        const base = index * 9;
        values.push(
          programId,
          entry.sequence.toString(),
          entry.deltaMinor.toString(),
          entry.component,
          entry.cause,
          entry.originReference,
          entry.actor,
          entry.correlationId,
          now,
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
      });
      await manager.query(
        `INSERT INTO capacity_ledger_entry
          (program_id, sequence, delta_minor, component, cause, origin_reference, actor, correlation_id, occurred_at)
         VALUES ${tuples.join(', ')}`,
        values,
      );
    }

    await manager.query(
      `UPDATE program
         SET credit_limit_minor = $1,
             local_reserved_minor = $2,
             treasury_reserved_minor = $3,
             next_sequence = $4,
             over_limit_since = $5,
             position_changed_at = $6
       WHERE id = $7`,
      [
        result.program.creditLimitMinor.toString(),
        result.program.localReservedMinor.toString(),
        result.program.treasuryReservedMinor.toString(),
        result.program.nextSequence.toString(),
        result.program.overLimitSince,
        now,
        programId,
      ],
    );
  }
}
