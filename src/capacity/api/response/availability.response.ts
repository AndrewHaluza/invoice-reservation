import { ApiProperty } from '@nestjs/swagger';
import type { AvailabilityBody } from '../../application/availability.projection';
import { MoneyResponse } from './money.response';

export class ReservedBreakdownResponse {
  @ApiProperty({
    type: () => MoneyResponse,
    description: 'Reserved capacity across every component.',
  })
  total!: MoneyResponse;

  @ApiProperty({
    type: () => MoneyResponse,
    description: 'Reserved capacity held against the local component.',
  })
  local!: MoneyResponse;

  @ApiProperty({
    type: () => MoneyResponse,
    description: 'Reserved capacity held against the treasury component.',
  })
  treasury!: MoneyResponse;
}

export class OverLimitResponse {
  @ApiProperty({
    type: Boolean,
    example: false,
    description: 'True while the program is over its credit limit.',
  })
  active!: boolean;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
    description: 'When the over-limit state began; null when not over limit.',
  })
  since!: string | null;
}

export class TreasuryStateResponse {
  @ApiProperty({
    type: Number,
    example: 7,
    description: 'Version of the last treasury message applied to the position.',
  })
  appliedVersion!: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
    description: 'Business effective time of the last applied treasury message.',
  })
  effectiveAt!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: null,
    description:
      'Seconds between the newest treasury message applied to this program and the newest one observed for it on the stream. Null when not knowable; null is never the same as zero.',
  })
  lagSeconds!: number | null;
}

export class AvailabilityResponse {
  @ApiProperty({
    type: String,
    format: 'uuid',
    example: 'b1b2c3d4-0001-4000-8000-000000000011',
  })
  programId!: string;

  @ApiProperty({ type: String, pattern: '^[A-Z]{3}$', example: 'USD' })
  currency!: string;

  @ApiProperty({ type: () => MoneyResponse })
  creditLimit!: MoneyResponse;

  @ApiProperty({ type: () => ReservedBreakdownResponse })
  reserved!: ReservedBreakdownResponse;

  @ApiProperty({ type: () => MoneyResponse })
  available!: MoneyResponse;

  @ApiProperty({
    type: Boolean,
    example: true,
    description: 'False while the cached position cannot be vouched for.',
  })
  positionVerified!: boolean;

  @ApiProperty({
    type: Boolean,
    example: false,
    description: 'True while a reconciliation discrepancy needs investigation.',
  })
  investigationRequired!: boolean;

  @ApiProperty({
    type: Boolean,
    example: false,
    description: 'True while a reconciliation is pending for this program.',
  })
  reconciliationPending!: boolean;

  @ApiProperty({ type: () => OverLimitResponse })
  overLimit!: OverLimitResponse;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'When the cached position last changed.',
  })
  positionChangedAt!: string;

  @ApiProperty({ type: () => TreasuryStateResponse })
  treasury!: TreasuryStateResponse;
}

// Compile-time mirror check: a field added to AvailabilityBody without a matching
// field here is a build error, not a silent documentation lie.
export type AvailabilityResponseMirrorsBody = AvailabilityResponse extends AvailabilityBody
  ? true
  : never;
