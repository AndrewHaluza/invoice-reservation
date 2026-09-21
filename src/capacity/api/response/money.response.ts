import { ApiProperty } from '@nestjs/swagger';

export class MoneyResponse {
  @ApiProperty({
    type: String,
    pattern: '^-?[0-9]+$',
    example: '150000',
    description:
      'Minor units as a decimal string. A string, not a number, because amounts exceed the safe integer range of JSON numbers and must never be parsed as a float. Negative where the value is a ledger delta.',
  })
  amountMinor!: string;

  @ApiProperty({
    type: String,
    pattern: '^[A-Z]{3}$',
    example: 'USD',
    description: 'ISO-4217 code. Always explicit; never implied by the program.',
  })
  currency!: string;
}

export class PositiveMoneyResponse {
  @ApiProperty({
    type: String,
    pattern: '^[1-9][0-9]{0,18}$',
    example: '150000',
    description: 'Minor units as a decimal string. Strictly positive.',
  })
  amountMinor!: string;

  @ApiProperty({ type: String, pattern: '^[A-Z]{3}$', example: 'USD' })
  currency!: string;
}
