import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ReservationStatus } from '../../application/audit-read.service';

const RESERVATION_STATUSES: readonly ReservationStatus[] = [
  'ACTIVE',
  'PARTIALLY_RELEASED',
  'FULLY_RELEASED',
  'CANCELLED',
  'WRITTEN_OFF',
];

export class ListReservationsQueryDto {
  @ApiPropertyOptional({
    type: String,
    enum: ['ACTIVE', 'PARTIALLY_RELEASED', 'FULLY_RELEASED', 'CANCELLED', 'WRITTEN_OFF'],
  })
  @IsOptional()
  @IsIn(RESERVATION_STATUSES)
  status?: ReservationStatus;

  @ApiPropertyOptional({
    type: String,
    description:
      "Opaque keyset cursor from a previous page's nextCursor. Pass it back verbatim; never parse or construct one.",
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
