import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('request_record')
export class RequestRecordEntity {
  @PrimaryColumn({ name: 'organisation_id', type: 'uuid' })
  organisationId!: string;

  @PrimaryColumn({ name: 'request_id', type: 'text' })
  requestId!: string;

  @Column({ name: 'operation', type: 'text' })
  operation!: string;

  @Column({ name: 'content_fingerprint', type: 'text' })
  contentFingerprint!: string;

  @Column({
    name: 'state',
    type: 'enum',
    enum: ['PENDING', 'COMPLETE'],
    enumName: 'request_state',
  })
  state!: 'PENDING' | 'COMPLETE';

  @Column({ name: 'outcome', type: 'jsonb', nullable: true })
  outcome!: Record<string, unknown> | null;

  @Column({ name: 'recorded_at', type: 'timestamptz' })
  recordedAt!: Date;
}
