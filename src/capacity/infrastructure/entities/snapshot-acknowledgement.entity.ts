import { Column, Entity, PrimaryColumn } from 'typeorm';
import { bigintTransformer } from './bigint.transformer';

@Entity('snapshot_acknowledgement')
export class SnapshotAcknowledgementEntity {
  @PrimaryColumn({ name: 'message_id', type: 'text' })
  messageId!: string;

  @Column({ name: 'program_id', type: 'uuid' })
  programId!: string;

  @Column({ name: 'version', type: 'bigint', transformer: bigintTransformer })
  version!: bigint;

  @Column({
    name: 'kind',
    type: 'enum',
    enum: ['EXPLICIT', 'WATERMARK'],
    enumName: 'ack_kind',
  })
  kind!: 'EXPLICIT' | 'WATERMARK';

  @Column({ name: 'reservation_references', type: 'text', array: true, nullable: true })
  reservationReferences!: string[] | null;

  @Column({ name: 'ingested_through', type: 'timestamptz', nullable: true })
  ingestedThrough!: Date | null;
}
