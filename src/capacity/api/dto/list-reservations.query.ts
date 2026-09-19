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
  @IsOptional()
  @IsIn(RESERVATION_STATUSES)
  status?: ReservationStatus;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
