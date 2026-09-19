import { Column, Entity, PrimaryColumn } from 'typeorm';
import { bigintTransformer } from './bigint.transformer';

@Entity('program_stream_position')
export class ProgramStreamPositionEntity {
  @PrimaryColumn({ name: 'program_id', type: 'uuid' })
  programId!: string;

  @PrimaryColumn({ name: 'topic', type: 'text' })
  topic!: string;

  @PrimaryColumn({ name: 'partition', type: 'int' })
  partition!: number;

  @Column({ name: 'offset', type: 'bigint', transformer: bigintTransformer })
  offsetValue!: bigint;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
