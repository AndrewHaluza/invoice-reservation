import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { currentCorrelationId } from '../../shared/correlation';
import { CapacityRefusal, RefusalCode } from '../domain/errors';

// Fixed, human-readable strings. They never interpolate an amount, an identifier
// or a program id; a caller branches on `code`, not on the prose.
const MESSAGES: Record<RefusalCode, string> = {
  INSUFFICIENT_CAPACITY: 'The amount exceeds available capacity.',
  PROGRAM_OVER_LIMIT: 'The program is over its credit limit.',
  FX_RATE_UNAVAILABLE:
    'No exchange rate is available for the requested currency pair.',
  AMOUNT_ROUNDS_TO_ZERO:
    'The converted amount rounds to zero in the program currency.',
  DUPLICATE_INVOICE:
    'A reservation already exists for this invoice on this program.',
  IDEMPOTENCY_CONFLICT:
    'The Idempotency-Key was used before with different content.',
  IDEMPOTENCY_EXPIRED:
    'The Idempotency-Key has expired and cannot be replayed.',
  REQUEST_IN_FLIGHT: 'An identical request is still being applied.',
  POSITION_UNVERIFIED:
    'The program position cannot be verified at this time.',
};

const STATUS: Record<RefusalCode, number> = {
  INSUFFICIENT_CAPACITY: 409,
  PROGRAM_OVER_LIMIT: 409,
  DUPLICATE_INVOICE: 409,
  IDEMPOTENCY_CONFLICT: 409,
  IDEMPOTENCY_EXPIRED: 409,
  REQUEST_IN_FLIGHT: 409,
  FX_RATE_UNAVAILABLE: 409,
  AMOUNT_ROUNDS_TO_ZERO: 409,
  POSITION_UNVERIFIED: 503,
};

const MAX_DETAILS = 20;

// A plain framework `HttpException` — an unmatched route's `NotFoundException`,
// a `MethodNotAllowedException`, a body-parser 413/415 — carries no `code`, so
// the generic branches would flatten it to a 500 and lose its HTTP semantics.
// These statuses keep their meaning and get a contract-shaped body instead.
const CODE_BY_STATUS: Record<number, string> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  406: 'NOT_ACCEPTABLE',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasStringCode(
  value: unknown,
): value is Record<string, unknown> & { code: string } {
  return isRecord(value) && typeof value.code === 'string';
}

// The boundary matrix forbids `api` from importing `infrastructure`, so
// `ProgramNotFoundError` is recognised structurally. The class sets `name` in
// its own constructor, so an instance always matches.
function isProgramNotFoundError(exception: unknown): boolean {
  return exception instanceof Error && exception.name === 'ProgramNotFoundError';
}

// The unique-violation backstop on `invoice_reservation_program_invoice_unique`.
// Detected structurally so no driver type is imported into the api layer.
function isUniqueViolation(exception: unknown): boolean {
  if (!(exception instanceof Error) || exception.name !== 'QueryFailedError') {
    return false;
  }
  const driverError = (exception as Error & { driverError?: unknown })
    .driverError;
  return isRecord(driverError) && driverError.code === '23505';
}

function toValidationDetails(payload: unknown): Record<string, string> {
  const messages =
    isRecord(payload) && Array.isArray(payload.message) ? payload.message : [];
  const details: Record<string, string> = {};
  for (const entry of messages.slice(0, MAX_DETAILS)) {
    if (typeof entry !== 'string' || entry.length === 0) {
      continue;
    }
    const key = entry.split(' ')[0] ?? entry;
    details[key] = entry;
  }
  return details;
}

@Catch()
export class CapacityErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(CapacityErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const correlationId = currentCorrelationId() ?? 'unknown';

    if (exception instanceof CapacityRefusal) {
      const body: Record<string, unknown> = {
        code: exception.code,
        message: MESSAGES[exception.code],
        correlationId,
      };
      if (exception.details !== undefined) {
        body.details = exception.details;
      }
      response.status(STATUS[exception.code]).json(body);
      return;
    }

    if (isProgramNotFoundError(exception)) {
      response.status(404).json({
        code: 'NOT_FOUND',
        message: 'Program not found.',
        correlationId,
      });
      return;
    }

    if (isUniqueViolation(exception)) {
      response.status(409).json({
        code: 'DUPLICATE_INVOICE',
        message: MESSAGES.DUPLICATE_INVOICE,
        correlationId,
      });
      return;
    }

    if (exception instanceof HttpException) {
      const payload = exception.getResponse();

      if (hasStringCode(payload)) {
        const body: Record<string, unknown> = { ...payload };
        if (body.correlationId === undefined) {
          body.correlationId = correlationId;
        }
        response.status(exception.getStatus()).json(body);
        return;
      }

      if (exception instanceof BadRequestException) {
        const details = toValidationDetails(payload);
        const body: Record<string, unknown> = {
          code: 'VALIDATION_FAILED',
          message: 'Request validation failed.',
          correlationId,
        };
        if (Object.keys(details).length > 0) {
          body.details = details;
        }
        response.status(exception.getStatus()).json(body);
        return;
      }

      const status = exception.getStatus();
      if (status < 500) {
        const message =
          typeof payload === 'string'
            ? payload
            : isRecord(payload) && typeof payload.message === 'string'
              ? payload.message
              : exception.message;
        response.status(status).json({
          code: CODE_BY_STATUS[status] ?? 'HTTP_ERROR',
          message,
          correlationId,
        });
        return;
      }
      // A 5xx HttpException is an unexpected failure: keep the generic INTERNAL
      // treatment below so its message is logged, never returned.
    }

    this.logger.error(
      `Unhandled exception: ${
        exception instanceof Error ? exception.message : String(exception)
      }`,
      exception instanceof Error ? exception.stack : undefined,
    );
    response.status(500).json({
      code: 'INTERNAL',
      message: 'An unexpected error occurred.',
      correlationId,
    });
  }
}
