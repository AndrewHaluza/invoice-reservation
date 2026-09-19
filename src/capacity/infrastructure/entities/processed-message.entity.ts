import { Column, Entity, PrimaryColumn } from 'typeorm';
import { bigintTransformer } from './bigint.transformer';

@Entity('processed_message')
export class ProcessedMessageEntity {
  @PrimaryColumn({ name: 'message_id', type: 'text' })
  messageId!: string;

  @Column({ name: 'program_id', type: 'uuid' })
  programId!: string;

  @Column({
    name: 'kind',
    type: 'enum',
    enum: ['EVENT', 'SNAPSHOT'],
    enumName: 'message_kind',
  })
  kind!: 'EVENT' | 'SNAPSHOT';

  @Column({ name: 'version', type: 'bigint', transformer: bigintTransformer })
  version!: bigint;

  @Column({ name: 'content_hash', type: 'text' })
  contentHash!: string;

  @Column({ name: 'processed_at', type: 'timestamptz' })
  processedAt!: Date;
}
