import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { currentCorrelationId } from '../../shared/correlation';
import { RequiredScope } from '../../shared/scope';
import { AuditReadService, Page } from '../application/audit-read.service';
import {
  AvailabilityBody,
} from '../application/availability.projection';
import { AvailabilityService } from '../application/availability.service';
import { CancelBody, CancelService } from '../application/cancel.service';
import { ReleaseBody, ReleaseService } from '../application/release.service';
import { ReserveBody, ReserveService } from '../application/reserve.service';
import { ReservationBody } from '../application/reservation.projection';
import { CancellationDto } from './dto/cancellation.dto';
import { CreateReleaseDto } from './dto/create-release.dto';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { ListReservationsQueryDto } from './dto/list-reservations.query';

// The global guard chain resolves ownership for the route parameter named exactly
// `programId`. The request shape is expressed locally because the boundary matrix
// forbids `api` from importing `auth`.
type ReservationRequest = Request & {
  auth: { org: string; scopes: Set<string> };
};

@Controller('v1/programs/:programId')
// Two named throttlers are registered globally ('read' 600/min, 'write' 120/min) and
// @nestjs/throttler applies EVERY named throttler to EVERY route unless the route opts
// out. The opt-out is per method, never on the class: a class-level `read` skip would
// leave the reads unthrottled, and the effective limit on every route would silently be
// the tighter of the two. Writes skip `read` (write budget only); reads skip `write`.
export class CapacityController {
  constructor(
    private readonly reserveService: ReserveService,
    private readonly releaseService: ReleaseService,
    private readonly cancelService: CancelService,
    private readonly availabilityService: AvailabilityService,
    private readonly auditReadService: AuditReadService,
  ) {}

  @Post('reservations')
  @RequiredScope('capacity:write')
  @SkipThrottle({ read: true })
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
        details: { idempotencyKey: 'required, 8 to 128 characters' },
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

  @Post('reservations/:invoiceId/releases')
  @RequiredScope('capacity:write')
  @SkipThrottle({ read: true })
  async createRelease(
    @Param('programId', new ParseUUIDPipe({ version: '4' })) programId: string,
    @Param('invoiceId') invoiceId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateReleaseDto,
    @Req() request: ReservationRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReleaseBody> {
    if (
      idempotencyKey === undefined ||
      idempotencyKey.length < 8 ||
      idempotencyKey.length > 128
    ) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Idempotency-Key is required.',
        details: { idempotencyKey: 'required, 8 to 128 characters' },
      });
    }

    const outcome = await this.releaseService.release({
      organisationId: request.auth.org,
      programId,
      requestId: idempotencyKey,
      invoiceId,
      releaseMinor: BigInt(dto.amount.amountMinor),
      currency: dto.amount.currency,
      actor: request.auth.org,
      correlationId: currentCorrelationId() ?? 'unknown',
    });

    response.status(outcome.created ? 201 : 200);
    return outcome.body;
  }

  @Post('reservations/:invoiceId/cancellation')
  @RequiredScope('capacity:write')
  @SkipThrottle({ read: true })
  async cancelReservation(
    @Param('programId', new ParseUUIDPipe({ version: '4' })) programId: string,
    @Param('invoiceId') invoiceId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CancellationDto,
    @Req() request: ReservationRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CancelBody> {
    if (
      idempotencyKey === undefined ||
      idempotencyKey.length < 8 ||
      idempotencyKey.length > 128
    ) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Idempotency-Key is required.',
        details: { idempotencyKey: 'required, 8 to 128 characters' },
      });
    }

    const outcome = await this.cancelService.cancel({
      organisationId: request.auth.org,
      programId,
      requestId: idempotencyKey,
      invoiceId,
      reason: dto.reason,
      note: dto.note ?? null,
      actor: request.auth.org,
      correlationId: currentCorrelationId() ?? 'unknown',
    });

    response.status(outcome.created ? 201 : 200);
    return outcome.body;
  }

  @Get('availability')
  @RequiredScope('capacity:read')
  @SkipThrottle({ write: true })
  getAvailability(
    @Param('programId', new ParseUUIDPipe({ version: '4' })) programId: string,
  ): Promise<AvailabilityBody> {
    return this.availabilityService.forProgram(programId);
  }

  @Get('reservations')
  @RequiredScope('capacity:read')
  @SkipThrottle({ write: true })
  listReservations(
    @Param('programId', new ParseUUIDPipe({ version: '4' })) programId: string,
    @Query() query: ListReservationsQueryDto,
  ): Promise<Page<ReservationBody>> {
    return this.auditReadService.listReservations(programId, query);
  }

  @Get('reservations/:invoiceId')
  @RequiredScope('capacity:read')
  @SkipThrottle({ write: true })
  getReservation(
    @Param('programId', new ParseUUIDPipe({ version: '4' })) programId: string,
    @Param('invoiceId') invoiceId: string,
  ): Promise<ReservationBody> {
    return this.auditReadService.getReservation(programId, invoiceId);
  }
}
