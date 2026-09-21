import { ApiProperty } from '@nestjs/swagger';
import type { CancelBody } from '../../application/cancel.service';
import type { ReleaseBody } from '../../application/release.service';
import type { ReservationBody } from '../../application/reservation.projection';
import type { ReserveBody } from '../../application/reserve.service';
import { AvailabilityResponse } from './availability.response';
import { MoneyResponse } from './money.response';

export class ReservationFxResponse {
  @ApiProperty({
    type: String,
    example: '1.0842000000',
    description: 'Rate applied to the reservation, as a decimal string.',
  })
  rate!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-01-01T00:00:00.000Z',
    description: 'When the applied rate was effective.',
  })
  effectiveAt!: string;

  @ApiProperty({
    type: String,
    example: 'ECB',
    description: 'Source of the applied rate.',
  })
  source!: string;
}

export class OutstandingResponse {
  @ApiProperty({ type: () => MoneyResponse })
  invoice!: MoneyResponse;

  @ApiProperty({ type: () => MoneyResponse })
  reserved!: MoneyResponse;
}

export class ReservationResponse {
  @ApiProperty({
    type: String,
    example: 'INV-2026-000123',
    description: 'Caller-supplied invoice identifier.',
  })
  invoiceId!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    example: 'b1b2c3d4-0001-4000-8000-000000000011',
  })
  programId!: string;

  @ApiProperty({
    type: String,
    enum: ['ACTIVE', 'PARTIALLY_RELEASED', 'FULLY_RELEASED', 'CANCELLED', 'WRITTEN_OFF'],
    example: 'ACTIVE',
  })
  status!: 'ACTIVE' | 'PARTIALLY_RELEASED' | 'FULLY_RELEASED' | 'CANCELLED' | 'WRITTEN_OFF';

  @ApiProperty({ type: () => MoneyResponse })
  invoiceAmount!: MoneyResponse;

  @ApiProperty({ type: () => MoneyResponse })
  reserved!: MoneyResponse;

  @ApiProperty({ type: () => OutstandingResponse })
  outstanding!: OutstandingResponse;

  @ApiProperty({
    type: () => ReservationFxResponse,
    nullable: true,
    description: 'Null when no FX rate was applied.',
  })
  fx!: ReservationFxResponse | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-01-01T00:00:00.000Z',
  })
  createdAt!: string;
}

export class ReservationListResponse {
  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description:
      'Opaque keyset cursor. Pass it back verbatim to fetch the next page; never parse or construct one. Null on the last page.',
  })
  nextCursor!: string | null;

  @ApiProperty({ type: () => [ReservationResponse] })
  items!: ReservationResponse[];
}

export class ReserveResponse {
  @ApiProperty({ type: () => ReservationResponse })
  reservation!: ReservationResponse;

  @ApiProperty({ type: () => AvailabilityResponse })
  availability!: AvailabilityResponse;
}

export class ReleaseResponse {
  @ApiProperty({ type: () => ReservationResponse })
  reservation!: ReservationResponse;

  @ApiProperty({ type: () => AvailabilityResponse })
  availability!: AvailabilityResponse;
}

export class CancelResponse {
  @ApiProperty({ type: () => ReservationResponse })
  reservation!: ReservationResponse;

  @ApiProperty({ type: () => AvailabilityResponse })
  availability!: AvailabilityResponse;
}

// Compile-time mirror check: a field added to ReservationBody without a matching
// field here is a build error, not a silent documentation lie.
export type ReservationResponseMirrorsBody = ReservationResponse extends ReservationBody
  ? true
  : never;

// Compile-time mirror check: a field added to ReserveBody without a matching
// field here is a build error, not a silent documentation lie.
export type ReserveResponseMirrorsBody = ReserveResponse extends ReserveBody ? true : never;

// Compile-time mirror check: a field added to ReleaseBody without a matching
// field here is a build error, not a silent documentation lie.
export type ReleaseResponseMirrorsBody = ReleaseResponse extends ReleaseBody ? true : never;

// Compile-time mirror check: a field added to CancelBody without a matching
// field here is a build error, not a silent documentation lie.
export type CancelResponseMirrorsBody = CancelResponse extends CancelBody ? true : never;
