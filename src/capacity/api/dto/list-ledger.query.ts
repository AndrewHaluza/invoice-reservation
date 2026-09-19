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
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @IsIn(LEDGER_CAUSES)
  cause?: LedgerCause;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;
}
