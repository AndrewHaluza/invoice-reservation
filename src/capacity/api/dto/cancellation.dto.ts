import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

const CANCELLATION_REASONS = ['CANCELLED', 'WRITTEN_OFF'] as const;

export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

export class CancellationDto {
  @IsIn(CANCELLATION_REASONS)
  reason!: CancellationReason;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  note?: string;
}
