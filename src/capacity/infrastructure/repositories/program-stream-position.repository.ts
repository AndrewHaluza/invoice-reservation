import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { StreamCoordinates } from '../../../shared/treasury/capacity-event';

@Injectable()
export class ProgramStreamPositionRepository {
  async upsert(
    manager: EntityManager,
    programId: string,
    coordinates: StreamCoordinates,
    now: Date,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO program_stream_position
         (program_id, topic, partition, "offset", updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (program_id, topic, partition)
       DO UPDATE SET "offset" = EXCLUDED."offset",
                     updated_at = EXCLUDED.updated_at
       WHERE program_stream_position."offset" < EXCLUDED."offset"`,
      [programId, coordinates.topic, coordinates.partition, coordinates.offset, now],
    );
  }
}
