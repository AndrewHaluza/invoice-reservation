import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { LedgerCause } from '../../domain/ledger-entry';

const LEDGER_CAUSES: readonly LedgerCause[] = [
  'RESERVATION',
  'RELEASE',
  'CANCELLATION',
  'WRITE_OFF',
  'TREASURY_EVENT',
  'LIMIT_CHANGE',
  'RECONCILIATION_ADJUSTMENT',
  'OVER_LIMIT_ONSET',
  'OVER_LIMIT_CLEARED',
];

export class ListLedgerQueryDto {
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Inclusive lower bound on occurredAt.',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Exclusive upper bound on occurredAt.',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({
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
  })
  @IsOptional()
  @IsIn(LEDGER_CAUSES)
  cause?: LedgerCause;

  @ApiPropertyOptional({
    type: String,
    description:
      "Opaque keyset cursor from a previous page's nextCursor. Pass it back verbatim; never parse or construct one.",
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 1000,
    default: 100,
    description:
      'The ledger is a bulk audit read and admits a larger page than the reservation list.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;
}
