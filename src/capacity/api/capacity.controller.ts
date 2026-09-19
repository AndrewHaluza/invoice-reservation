import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { currentCorrelationId } from '../../shared/correlation';
import { RequiredScope } from '../../shared/scope';
import { ReserveBody, ReserveService } from '../application/reserve.service';
import { CreateReservationDto } from './dto/create-reservation.dto';

// The global guard chain resolves ownership for the route parameter named exactly
// `programId`. The request shape is expressed locally because the boundary matrix
// forbids `api` from importing `auth`.
type ReservationRequest = Request & {
  auth: { org: string; scopes: Set<string> };
};

@Controller('v1/programs/:programId/reservations')
// Two named throttlers are registered globally ('read' 600/min, 'write' 120/min) and
// @nestjs/throttler applies EVERY named throttler to EVERY route unless the route opts
// out. Without this line a write would also consume the read budget, and the effective
// limit on every route would silently be the tighter of the two.
@SkipThrottle({ read: true })
export class CapacityController {
  constructor(private readonly reserveService: ReserveService) {}

  @Post()
  @RequiredScope('capacity:write')
  async createReservation(
    @Param('programId', new ParseUUIDPipe({ version: '4' })) programId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateReservationDto,
    @Req() request: ReservationRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReserveBody> {
    if (
      idempotencyKey === undefined ||
      idempotencyKey.length < 8 ||
      idempotencyKey.length > 128
    ) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Idempotency-Key is required.',
        details: { 'Idempotency-Key': 'required, 8 to 128 characters' },
      });
    }

    const outcome = await this.reserveService.reserve({
      organisationId: request.auth.org,
      programId,
      requestId: idempotencyKey,
      invoiceId: dto.invoiceId,
      amountMinor: BigInt(dto.amount.amountMinor),
      currency: dto.amount.currency,
      actor: request.auth.org,
      correlationId: currentCorrelationId() ?? 'unknown',
    });

    response.status(outcome.created ? 201 : 200);
    return outcome.body;
  }
}
