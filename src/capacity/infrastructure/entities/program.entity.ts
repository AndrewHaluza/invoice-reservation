import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { bigintTransformer } from './bigint.transformer';

@Entity('program')
export class ProgramEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  @Column({ name: 'organisation_id', type: 'uuid' })
  organisationId!: string;

  @Column({ name: 'currency', type: 'char', length: 3 })
  currency!: string;

  @Column({ name: 'credit_limit_minor', type: 'bigint', transformer: bigintTransformer })
  creditLimitMinor!: bigint;

  @Column({ name: 'local_reserved_minor', type: 'bigint', transformer: bigintTransformer })
  localReservedMinor!: bigint;

  @Column({ name: 'treasury_reserved_minor', type: 'bigint', transformer: bigintTransformer })
  treasuryReservedMinor!: bigint;

  @Column({ name: 'next_sequence', type: 'bigint', transformer: bigintTransformer })
  nextSequence!: bigint;

  @Column({ name: 'over_limit_since', type: 'timestamptz', nullable: true })
  overLimitSince!: Date | null;

  @Column({ name: 'treasury_version', type: 'bigint', transformer: bigintTransformer })
  treasuryVersion!: bigint;

  @Column({ name: 'treasury_effective_at', type: 'timestamptz', nullable: true })
  treasuryEffectiveAt!: Date | null;

  @Column({ name: 'treasury_applied_effective_at', type: 'timestamptz', nullable: true })
  treasuryAppliedEffectiveAt!: Date | null;

  @Column({ name: 'position_changed_at', type: 'timestamptz' })
  positionChangedAt!: Date;

  @Column({ name: 'investigation_required', type: 'boolean' })
  investigationRequired!: boolean;

  @Column({ name: 'position_verified', type: 'boolean' })
  positionVerified!: boolean;
}
