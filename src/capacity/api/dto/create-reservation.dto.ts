import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsObject, IsString, Length, Matches, Validate, ValidateNested } from 'class-validator';
import { PositiveMoneyResponse } from '../response';
import { FitsInt64, MoneyDto } from './money.dto';

export class PositiveMoneyDto extends MoneyDto {
  @ApiProperty({
    type: String,
    pattern: '^[1-9][0-9]{0,18}$',
    example: '150000',
    description: 'Minor units as a decimal string. Strictly positive.',
  })
  @IsString()
  @Matches(/^[1-9][0-9]{0,18}$/, { message: 'amountMinor must be a positive integer string' })
  @Validate(FitsInt64)
  declare amountMinor: string;
}

export class CreateReservationDto {
  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 128,
    example: 'INV-2026-000481',
    description: "The financing client's own invoice identifier. Unique per program.",
  })
  @IsString()
  @Length(1, 128)
  invoiceId!: string;

  @ApiProperty({
    type: () => PositiveMoneyResponse,
    description:
      'Amount to reserve, in the program currency or a currency convertible to it.',
  })
  @ValidateNested()
  @Type(() => PositiveMoneyDto)
  @IsObject()
  amount!: PositiveMoneyDto;
}
