import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  Matches,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

@ValidatorConstraint({ name: 'fitsInt64', async: false })
export class FitsInt64 implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string' || !/^-?[0-9]{1,19}$/.test(value)) return false;
    const parsed = BigInt(value);
    return parsed >= INT64_MIN && parsed <= INT64_MAX;
  }

  defaultMessage(): string {
    return 'amountMinor must be an integer that fits a signed 64-bit value';
  }
}

export class MoneyDto {
  @ApiProperty({ type: String, pattern: '^-?[0-9]+$', example: '150000' })
  @IsString()
  @Matches(/^-?[0-9]{1,19}$/, { message: 'amountMinor must be an integer string' })
  @Validate(FitsInt64)
  amountMinor!: string;

  @ApiProperty({ type: String, pattern: '^[A-Z]{3}$', example: 'USD' })
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO-4217 alphabetic code' })
  currency!: string;
}
