import { Type } from 'class-transformer';
import { IsObject, IsString, Length, Matches, Validate, ValidateNested } from 'class-validator';
import { FitsInt64, MoneyDto } from './money.dto';

export class PositiveMoneyDto extends MoneyDto {
  @IsString()
  @Matches(/^[1-9][0-9]{0,18}$/, { message: 'amountMinor must be a positive integer string' })
  @Validate(FitsInt64)
  declare amountMinor: string;
}

export class CreateReservationDto {
  @IsString()
  @Length(1, 128)
  invoiceId!: string;

  @ValidateNested()
  @Type(() => PositiveMoneyDto)
  @IsObject()
  amount!: PositiveMoneyDto;
}
