import { Column, Entity, PrimaryColumn } from 'typeorm';
import { bigintTransformer } from './bigint.transformer';

@Entity('stream_position')
export class StreamPositionEntity {
  @PrimaryColumn({ name: 'topic', type: 'text' })
  topic!: string;

  @PrimaryColumn({ name: 'partition', type: 'int' })
  partition!: number;

  @Column({ name: 'offset', type: 'bigint', transformer: bigintTransformer })
  offsetValue!: bigint;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
