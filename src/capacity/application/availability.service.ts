import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CapacityRefusal } from '../domain/errors';
import { ProgramRepository } from '../infrastructure/repositories/program.repository';
import { AvailabilityBody, toAvailabilityBody } from './availability.projection';

interface PendingRow {
  pending: boolean;
}

@Injectable()
export class AvailabilityService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly programRepository: ProgramRepository,
  ) {}

  // Pure assembly: a plain SELECT with no row lock. The position columns are only
  // ever written inside the locked transaction, so a committed read is
  // consistent on its own and reads are never serialised behind writes.
  async forProgram(programId: string): Promise<AvailabilityBody> {
    const program = await this.programRepository.findById(
      this.dataSource,
      programId,
    );
    if (program === null) {
      throw new CapacityRefusal('NOT_FOUND');
    }

    const reconciliationPending = await this.reconciliationPending(programId);
    return toAvailabilityBody(program, reconciliationPending);
  }

  // Derived at read time, never stored. True when the most recently applied
  // explicit snapshot acknowledged a reservation that has since left ACTIVE.
  // Phase 8 writes the acknowledgement rows this reads; until then the
  // predicate is simply false.
  private async reconciliationPending(programId: string): Promise<boolean> {
    // Scoped to EXPLICIT: a later WATERMARK is not evidence that an explicit acknowledgement was corrected.
    const rows = await this.dataSource.query<PendingRow[]>(
      `SELECT EXISTS (
         SELECT 1
           FROM snapshot_acknowledgement sa
           JOIN invoice_reservation r
             ON r.program_id = sa.program_id
            AND r.treasury_reference = ANY (sa.reservation_references)
          WHERE sa.program_id = $1
            AND sa.kind = 'EXPLICIT'
            AND r.status <> 'ACTIVE'
            AND sa.version = (
              SELECT MAX(version)
                FROM snapshot_acknowledgement
               WHERE program_id = $1 AND kind = 'EXPLICIT'
            )
       ) AS pending`,
      [programId],
    );
    return rows[0]?.pending === true;
  }
}
