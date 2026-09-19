import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { bigintTransformer } from './bigint.transformer';

@Entity('invoice_reservation')
export class InvoiceReservationEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id!: string;

  @Column({ name: 'program_id', type: 'uuid' })
  programId!: string;

  @Column({ name: 'invoice_id', type: 'text' })
  invoiceId!: string;

  @Column({ name: 'invoice_amount_minor', type: 'bigint', transformer: bigintTransformer })
  invoiceAmountMinor!: bigint;

  @Column({ name: 'invoice_currency', type: 'char', length: 3 })
  invoiceCurrency!: string;

  @Column({ name: 'program_currency', type: 'char', length: 3 })
  programCurrency!: string;

  @Column({ name: 'reserved_minor', type: 'bigint', transformer: bigintTransformer })
  reservedMinor!: bigint;

  @Column({ name: 'outstanding_invoice_minor', type: 'bigint', transformer: bigintTransformer })
  outstandingInvoiceMinor!: bigint;

  @Column({ name: 'outstanding_reserved_minor', type: 'bigint', transformer: bigintTransformer })
  outstandingReservedMinor!: bigint;

  @Column({ name: 'fx_rate', type: 'numeric', precision: 20, scale: 10, nullable: true })
  fxRate!: string | null;

  @Column({ name: 'fx_rate_effective_at', type: 'timestamptz', nullable: true })
  fxRateEffectiveAt!: Date | null;

  @Column({ name: 'fx_rate_source', type: 'text', nullable: true })
  fxRateSource!: string | null;

  @Column({
    name: 'status',
    type: 'enum',
    enum: ['ACTIVE', 'PARTIALLY_RELEASED', 'FULLY_RELEASED', 'CANCELLED', 'WRITTEN_OFF'],
    enumName: 'reservation_status',
  })
  status!: 'ACTIVE' | 'PARTIALLY_RELEASED' | 'FULLY_RELEASED' | 'CANCELLED' | 'WRITTEN_OFF';

  @Column({
    name: 'origin',
    type: 'enum',
    enum: ['LOCAL', 'TREASURY'],
    enumName: 'reservation_origin',
  })
  origin!: 'LOCAL' | 'TREASURY';

  @Column({ name: 'treasury_acknowledged', type: 'boolean' })
  treasuryAcknowledged!: boolean;

  @Column({
    name: 'acknowledged_by_version',
    type: 'bigint',
    transformer: bigintTransformer,
    nullable: true,
  })
  acknowledgedByVersion!: bigint | null;

  @Column({ name: 'treasury_reference', type: 'text', nullable: true })
  treasuryReference!: string | null;

  @Column({ name: 'confirmed_at', type: 'timestamptz' })
  confirmedAt!: Date;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
