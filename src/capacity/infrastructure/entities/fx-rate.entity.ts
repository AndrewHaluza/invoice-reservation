import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('fx_rate')
export class FxRateEntity {
  @PrimaryColumn({ name: 'base_currency', type: 'char', length: 3 })
  baseCurrency!: string;

  @PrimaryColumn({ name: 'quote_currency', type: 'char', length: 3 })
  quoteCurrency!: string;

  @PrimaryColumn({ name: 'effective_at', type: 'timestamptz' })
  effectiveAt!: Date;

  @Column({ name: 'rate', type: 'numeric', precision: 20, scale: 10 })
  rate!: string | null;

  @Column({ name: 'source', type: 'text' })
  source!: string;
}
