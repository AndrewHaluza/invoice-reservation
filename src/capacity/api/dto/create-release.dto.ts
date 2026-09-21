import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsObject, ValidateNested } from 'class-validator';
import { PositiveMoneyResponse } from '../response';
import { PositiveMoneyDto } from './create-reservation.dto';

export class CreateReleaseDto {
  @ApiProperty({
    type: () => PositiveMoneyResponse,
    description:
      "Amount to release. Must be denominated in the invoice's own currency and must not exceed what remains reserved.",
  })
  @ValidateNested()
  @Type(() => PositiveMoneyDto)
  @IsObject()
  amount!: PositiveMoneyDto;
}
