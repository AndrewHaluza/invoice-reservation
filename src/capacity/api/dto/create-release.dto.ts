import { Type } from 'class-transformer';
import { IsObject, ValidateNested } from 'class-validator';
import { PositiveMoneyDto } from './create-reservation.dto';

export class CreateReleaseDto {
  @ValidateNested()
  @Type(() => PositiveMoneyDto)
  @IsObject()
  amount!: PositiveMoneyDto;
}
