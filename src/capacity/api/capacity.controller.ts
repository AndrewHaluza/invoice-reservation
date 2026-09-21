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
import {
  ApiExtension,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
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
import {
  AvailabilityResponse,
  CancelResponse,
  ErrorResponse,
  ReleaseResponse,
  ReservationListResponse,
  ReservationResponse,
  ReserveResponse,
} from './response';

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
  @ApiTags('capacity')
  @ApiOperation({
    operationId: 'createReservation',
    summary: 'Reserve capacity for an approved invoice',
  })
  @ApiExtension('x-required-scope', 'capacity:write')
  @ApiParam({
    name: 'programId',
    type: String,
    format: 'uuid',
    required: true,
    example: 'b1b2c3d4-0001-4000-8000-000000000011',
  })
  @ApiHeader({
    name: 'x-correlation-id',
    required: false,
    description: 'Echoed on the response and propagated to logs and downstream messages.',
    schema: { type: 'string', maxLength: 128 },
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Required, 8 to 128 characters. A replay carrying identical content returns the original outcome with status 200. A replay carrying different content is refused 409 IDEMPOTENCY_CONFLICT — the original outcome is never replayed for a differing request. Retained at least 30 days.',
    schema: {
      type: 'string',
      minLength: 8,
      maxLength: 128,
      example: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    },
  })
  @ApiResponse({ status: 201, description: 'Created', type: ReserveResponse })
  @ApiResponse({
    status: 200,
    description:
      'Replay of a previous request carrying the same Idempotency-Key and identical content',
    type: ReserveResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_FAILED',
    type: ErrorResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'UNAUTHORIZED. The bearer token is missing, malformed, or expired.',
    type: ErrorResponse,
  })
  @ApiResponse({
    status: 403,
    description:
      'FORBIDDEN. The credential lacks the required scope. This says nothing about whether the program exists.',
    type: ErrorResponse,
  })
  @ApiResponse({
    status: 404,
    description:
      'NOT_FOUND. The program or reservation does not exist, or it belongs to another organisation — the two are deliberately indistinguishable.',
    type: ErrorResponse,
  })
  @ApiResponse({
    status: 409,
    description:
      'INSUFFICIENT_CAPACITY, PROGRAM_OVER_LIMIT, DUPLICATE_INVOICE, IDEMPOTENCY_CONFLICT, IDEMPOTENCY_EXPIRED, REQUEST_IN_FLIGHT, FX_RATE_UNAVAILABLE, AMOUNT_ROUNDS_TO_ZERO',
    type: ErrorResponse,
  })
  @ApiResponse({
    status: 429,
    description:
      'Rate limit exceeded for the calling organisation. Writes are limited to 120 requests per minute.',
    type: ErrorResponse,
  })
  @ApiResponse({
    status: 503,
    description: 'POSITION_UNVERIFIED. The program position cannot be verified at this time.',
    type: ErrorResponse,
  })
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
  @ApiTags('capacity')
  @ApiOperation({
    operationId: 'createRelease',
    summary: "Release part or all of an invoice's reserved capacity",
  })
  @ApiExtension('x-required-scope', 'capacity:write')
  @ApiParam({
    name: 'programId',
    type: String,
    format: 'uuid',
    required: true,
    example: 'b1b2c3d4-0001-4000-8000-000000000011',
  })
  @ApiParam({
    name: 'invoiceId',
    type: String,
    required: true,
    example: 'INV-2026-000481',
  })
  @ApiHeader({
    name: 'x-correlation-id',
    required: false,
    description: 'Echoed on the response and propagated to logs and downstream messages.',
    schema: { type: 'string', maxLength: 128 },
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Required, 8 to 128 characters. A replay carrying identical content returns the original outcome with status 200. A replay carrying different content is refused 409 IDEMPOTENCY_CONFLICT — the original outcome is never replayed for a differing request. Retained at least 30 days.',
    schema: {
      type: 'string',
      minLength: 8,
      maxLength: 128,
      example: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    },
  })
  @ApiResponse({ status: 201, description: 'Created', type: ReleaseResponse })
  @ApiResponse({
    status: 200,
    description:
      'Replay of a previous request carrying the same Idempotency-Key and identical content',
    type: ReleaseResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_FAILED',
    type: ErrorResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'UNAUTHORIZED. The bearer token is missing, malformed, or expired.',
    type: ErrorResponse,
  })
  @ApiResponse({
    status: 403,
    description:
      'FORBIDDEN. The credential lacks the required scope. This says nothing about whether the program exists.',
    type: ErrorResponse,
  })
  @ApiResponse({
    status: 404,
    description:
      'NOT_FOUND. The program or reservation does not exist, or it belongs to another organisation — the two are deliberately indistinguishable.',
    type: ErrorResponse,
  })
  @ApiResponse({
    status: 409,
    description: [
      'CURRENCY_MISMATCH',
      'RESERVATION_TERMINAL',
      'RELEASE_EXCEEDS_RESERVED',
      'IDEMPOTENCY_CONFLICT',
      'IDEMPOTENCY_EXPIRED',
      'REQUEST_IN_FLIGHT',
    ].join(', '),
    type: ErrorResponse,
  })
  @ApiResponse({
    status: 429,
    description:
      'Rate limit exceeded for the calling organisation. Writes are limited to 120 requests per minute.',
    type: ErrorResponse,
  })
  @ApiResponse({
    status: 503,
    description: 'POSITION_UNVERIFIED. The program position cannot be verified at this time.',
    type: ErrorResponse,
  })
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
  @ApiTags('capacity')
  @ApiOperation({
    operationId: 'cancelReservation',
    summary: 'Cancel a reservation, returning or writing off its capacity',
  })
  @ApiExtension('x-required-scope', 'capacity:write')
  @ApiParam({
    name: 'programId',
    type: String,
    format: 'uuid',
    required: true,
    example: 'b1b2c3d4-0001-4000-8000-000000000011',
  })
  @ApiParam({
    name: 'invoiceId',
    type: String,
    required: true,
    example: 'INV-2026-000481',
  })
  @ApiHeader({
    name: 'x-correlation-id',
    required: false,
    description: 'Echoed on the response and propagated to logs and downstream messages.',
    schema: { type: 'string', maxLength: 128 },
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Required, 8 to 128 characters. A replay carrying identical content returns the original outcome with status 200. A replay carrying different content is refused 409 IDEMPOTENCY_CONFLICT — the original outcome is never replayed for a differing request. Retained at least 30 days.',
    schema: {
      type: 'string',
      minLength: 8,
      maxLength: 128,
      example: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    },
  })
  @ApiResponse({ status: 201, description: 'Created', type: CancelResponse })
  @ApiResponse({
    status: 200,
    description:
      'Replay of a previous request carrying the same Idempotency-Key and identical content',
    type: CancelResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_FAILED',
    type: ErrorResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'UNAUTHORIZED. The bearer token is missing, malformed, or expired.',
    type: ErrorResponse,
  })
  @ApiResponse({
    status: 403,
    description:
      'FORBIDDEN. The credential lacks the required scope. This says nothing about whether the program exists.',
    type: ErrorResponse,
  })
  @ApiResponse({
    status: 404,
    description:
      'NOT_FOUND. The program or reservation does not exist, or it belongs to another organisation — the two are deliberately indistinguishable.',
    type: ErrorResponse,
  })
  @ApiResponse({
    status: 409,
    description: [
      'RESERVATION_TERMINAL',
      'IDEMPOTENCY_CONFLICT',
      'IDEMPOTENCY_EXPIRED',
      'REQUEST_IN_FLIGHT',
    ].join(', '),
    type: ErrorResponse,
  })
  @ApiResponse({
    status: 429,
    description:
      'Rate limit exceeded for the calling organisation. Writes are limited to 120 requests per minute.',
    type: ErrorResponse,
  })
  @ApiResponse({
    status: 503,
    description: 'POSITION_UNVERIFIED. The program position cannot be verified at this time.',
    type: ErrorResponse,
  })
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
  @ApiTags('capacity')
  @ApiOperation({
    operationId: 'getAvailability',
    summary: "Read a program's current capacity position",
  })
  @ApiExtension('x-required-scope', 'capacity:read')
  @ApiParam({
    name: 'programId',
    type: String,
    format: 'uuid',
    required: true,
    example: 'b1b2c3d4-0001-4000-8000-000000000011',
  })
  @ApiHeader({
    name: 'x-correlation-id',
    required: false,
    description: 'Echoed on the response and propagated to logs and downstream messages.',
    schema: { type: 'string', maxLength: 128 },
  })
  @ApiResponse({ status: 200, description: 'OK', type: AvailabilityResponse })
  @ApiResponse({
    status: 401,
    description: 'UNAUTHORIZED. The bearer token is missing, malformed, or expired.',
    type: ErrorResponse,
  })
  @ApiResponse({
    status: 403,
    description:
      'FORBIDDEN. The credential lacks the required scope. This says nothing about whether the program exists.',
    type: ErrorResponse,
  })
  @ApiResponse({
    status: 404,
    description:
      'NOT_FOUND. The program or reservation does not exist, or it belongs to another organisation — the two are deliberately indistinguishable.',
    type: ErrorResponse,
  })
  @ApiResponse({
    status: 429,
    description:
      'Rate limit exceeded for the calling organisation. Reads are limited to 600 requests per minute.',
    type: ErrorResponse,
  })
  getAvailability(
    @Param('programId', new ParseUUIDPipe({ version: '4' })) programId: string,
  ): Promise<AvailabilityBody> {
    return this.availabilityService.forProgram(programId);
  }

  @Get('reservations')
  @RequiredScope('capacity:read')
  @SkipThrottle({ write: true })
  @ApiTags('audit')
  @ApiOperation({
    operationId: 'listReservations',
    summary: "List a program's reservations, newest first",
  })
  @ApiExtension('x-required-scope', 'capacity:read')
  @ApiParam({
    name: 'programId',
    type: String,
    format: 'uuid',
    required: true,
    example: 'b1b2c3d4-0001-4000-8000-000000000011',
  })
  @ApiHeader({
    name: 'x-correlation-id',
    required: false,
    description: 'Echoed on the response and propagated to logs and downstream messages.',
    schema: { type: 'string', maxLength: 128 },
  })
  @ApiResponse({ status: 200, description: 'OK', type: ReservationListResponse })
  @ApiResponse({
    status: 401,
    description: 'UNAUTHORIZED. The bearer token is missing, malformed, or expired.',
    type: ErrorResponse,
  })
  @ApiResponse({
    status: 403,
    description:
      'FORBIDDEN. The credential lacks the required scope. This says nothing about whether the program exists.',
    type: ErrorResponse,
  })
  @ApiResponse({
    status: 404,
    description:
      'NOT_FOUND. The program or reservation does not exist, or it belongs to another organisation — the two are deliberately indistinguishable.',
    type: ErrorResponse,
  })
  @ApiResponse({
    status: 429,
    description:
      'Rate limit exceeded for the calling organisation. Reads are limited to 600 requests per minute.',
    type: ErrorResponse,
  })
  listReservations(
    @Param('programId', new ParseUUIDPipe({ version: '4' })) programId: string,
    @Query() query: ListReservationsQueryDto,
  ): Promise<Page<ReservationBody>> {
    return this.auditReadService.listReservations(programId, query);
  }

  @Get('reservations/:invoiceId')
  @RequiredScope('capacity:read')
  @SkipThrottle({ write: true })
  @ApiTags('audit')
  @ApiOperation({
    operationId: 'getReservation',
    summary: 'Read a single reservation by invoice id',
  })
  @ApiExtension('x-required-scope', 'capacity:read')
  @ApiParam({
    name: 'programId',
    type: String,
    format: 'uuid',
    required: true,
    example: 'b1b2c3d4-0001-4000-8000-000000000011',
  })
  @ApiParam({
    name: 'invoiceId',
    type: String,
    required: true,
    example: 'INV-2026-000481',
  })
  @ApiHeader({
    name: 'x-correlation-id',
    required: false,
    description: 'Echoed on the response and propagated to logs and downstream messages.',
    schema: { type: 'string', maxLength: 128 },
  })
  @ApiResponse({ status: 200, description: 'OK', type: ReservationResponse })
  @ApiResponse({
    status: 401,
    description: 'UNAUTHORIZED. The bearer token is missing, malformed, or expired.',
    type: ErrorResponse,
  })
  @ApiResponse({
    status: 403,
    description:
      'FORBIDDEN. The credential lacks the required scope. This says nothing about whether the program exists.',
    type: ErrorResponse,
  })
  @ApiResponse({
    status: 404,
    description:
      'NOT_FOUND. The program or reservation does not exist, or it belongs to another organisation — the two are deliberately indistinguishable.',
    type: ErrorResponse,
  })
  @ApiResponse({
    status: 429,
    description:
      'Rate limit exceeded for the calling organisation. Reads are limited to 600 requests per minute.',
    type: ErrorResponse,
  })
  getReservation(
    @Param('programId', new ParseUUIDPipe({ version: '4' })) programId: string,
    @Param('invoiceId') invoiceId: string,
  ): Promise<ReservationBody> {
    return this.auditReadService.getReservation(programId, invoiceId);
  }
}
