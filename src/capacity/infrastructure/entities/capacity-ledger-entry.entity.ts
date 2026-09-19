import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { bigintTransformer } from './bigint.transformer';

@Entity('capacity_ledger_entry')
export class CapacityLedgerEntryEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  @Column({ name: 'program_id', type: 'uuid' })
  programId!: string;

  @Column({ name: 'sequence', type: 'bigint', transformer: bigintTransformer })
  sequence!: bigint;

  @Column({ name: 'delta_minor', type: 'bigint', transformer: bigintTransformer })
  deltaMinor!: bigint;

  @Column({
    name: 'component',
    type: 'enum',
    enum: ['LOCAL', 'TREASURY', 'LIMIT'],
    enumName: 'position_component',
  })
  component!: 'LOCAL' | 'TREASURY' | 'LIMIT';

  @Column({
    name: 'cause',
    type: 'enum',
    enum: [
      'RESERVATION',
      'RELEASE',
      'CANCELLATION',
      'WRITE_OFF',
      'TREASURY_EVENT',
      'LIMIT_CHANGE',
      'RECONCILIATION_ADJUSTMENT',
      'OVER_LIMIT_ONSET',
      'OVER_LIMIT_CLEARED',
    ],
    enumName: 'ledger_cause',
  })
  cause!:
    | 'RESERVATION'
    | 'RELEASE'
    | 'CANCELLATION'
    | 'WRITE_OFF'
    | 'TREASURY_EVENT'
    | 'LIMIT_CHANGE'
    | 'RECONCILIATION_ADJUSTMENT'
    | 'OVER_LIMIT_ONSET'
    | 'OVER_LIMIT_CLEARED';

  @Column({ name: 'origin_reference', type: 'text', nullable: true })
  originReference!: string | null;

  @Column({ name: 'actor', type: 'text' })
  actor!: string;

  @Column({ name: 'correlation_id', type: 'text' })
  correlationId!: string;

  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;
}
