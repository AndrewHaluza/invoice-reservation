import { ApiProperty } from '@nestjs/swagger';
import type { LedgerEntryBody } from '../../application/audit-read.service';
import { MoneyResponse } from './money.response';

export class LedgerEntryResponse {
  @ApiProperty({
    type: Number,
    example: 42,
    description: 'Per-program, gapless sequence assigned when the entry was written.',
  })
  sequence!: number;

  @ApiProperty({ type: () => MoneyResponse })
  delta!: MoneyResponse;

  @ApiProperty({
    type: String,
    enum: ['LOCAL', 'TREASURY', 'LIMIT'],
    example: 'LOCAL',
  })
  component!: 'LOCAL' | 'TREASURY' | 'LIMIT';

  @ApiProperty({
    type: String,
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
    example: 'RESERVATION',
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

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'INV-2026-000123',
    description: 'The business object the entry is about; null when not applicable.',
  })
  originReference!: string | null;

  @ApiProperty({
    type: String,
    example: 'user:8f2a9c14',
    description: 'Who caused the entry.',
  })
  actor!: string;

  @ApiProperty({
    type: String,
    example: '3f2a9c14-8e7b-4a51-9f10-2d6c4b8e1a37',
    description: 'Correlation id of the request that wrote the entry.',
  })
  correlationId!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'When the entry occurred.',
  })
  occurredAt!: string;
}

export class LedgerListResponse {
  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description:
      'Opaque keyset cursor. Pass it back verbatim to fetch the next page; never parse or construct one. Null on the last page.',
  })
  nextCursor!: string | null;

  @ApiProperty({ type: () => [LedgerEntryResponse] })
  items!: LedgerEntryResponse[];
}

// Compile-time mirror check: a field added to LedgerEntryBody without a matching
// field here is a build error, not a silent documentation lie.
export type LedgerEntryResponseMirrorsBody = LedgerEntryResponse extends LedgerEntryBody
  ? true
  : never;
