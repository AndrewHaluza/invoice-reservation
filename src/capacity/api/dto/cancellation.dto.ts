import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

const CANCELLATION_REASONS = ['CANCELLED', 'WRITTEN_OFF'] as const;

export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

export class CancellationDto {
  @ApiProperty({
    type: String,
    enum: ['CANCELLED', 'WRITTEN_OFF'],
    example: 'CANCELLED',
    description:
      'CANCELLED returns the full reserved amount to available capacity. WRITTEN_OFF closes the reservation as an unrecoverable loss.',
  })
  @IsIn(CANCELLATION_REASONS)
  reason!: CancellationReason;

  @ApiPropertyOptional({
    type: String,
    maxLength: 512,
    example: 'Buyer withdrew the order before shipment.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  note?: string;
}
