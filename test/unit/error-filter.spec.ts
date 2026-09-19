import 'reflect-metadata';
import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
  MethodNotAllowedException,
  NotFoundException,
} from '@nestjs/common';
import { CapacityErrorFilter } from '../../src/capacity/api/error.filter';
import { CapacityRefusal, RefusalCode } from '../../src/capacity/domain/errors';
import { ProgramNotFoundError } from '../../src/capacity/infrastructure/unit-of-work';

interface CapturedResponse {
  status: number | undefined;
  body: Record<string, unknown> | undefined;
}

const invoke = (exception: unknown): CapturedResponse => {
  const captured: CapturedResponse = { status: undefined, body: undefined };
  const response = {
    status(code: number) {
      captured.status = code;
      return response;
    },
    json(body: Record<string, unknown>) {
      captured.body = body;
      return response;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;

  new CapacityErrorFilter().catch(exception, host);
  return captured;
};

const REFUSAL_STATUS: Record<RefusalCode, number> = {
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

describe('CapacityErrorFilter', () => {
  const codes = Object.keys(REFUSAL_STATUS) as RefusalCode[];

  it.each(codes)('maps %s to its tabled status and code', (code) => {
    const { status, body } = invoke(new CapacityRefusal(code));

    expect(status).toBe(REFUSAL_STATUS[code]);
    expect(body?.code).toBe(code);
    expect(typeof body?.message).toBe('string');
    expect(typeof body?.correlationId).toBe('string');
  });

  it('produces 503 for POSITION_UNVERIFIED, not 409', () => {
    const { status } = invoke(new CapacityRefusal('POSITION_UNVERIFIED'));

    expect(status).toBe(503);
  });

  it('carries refusal details and omits details when there are none', () => {
    const withDetails = invoke(
      new CapacityRefusal('INSUFFICIENT_CAPACITY', {
        requestedMinor: '10',
        availableMinor: '5',
      }),
    );
    expect(withDetails.body?.details).toEqual({
      requestedMinor: '10',
      availableMinor: '5',
    });

    const withoutDetails = invoke(new CapacityRefusal('DUPLICATE_INVOICE'));
    expect(withoutDetails.body).not.toHaveProperty('details');
  });

  it('maps ProgramNotFoundError to 404 NOT_FOUND', () => {
    const { status, body } = invoke(
      new ProgramNotFoundError('b1b2c3d4-0001-4000-8000-000000000011'),
    );

    expect(status).toBe(404);
    expect(body?.code).toBe('NOT_FOUND');
  });

  it('passes a guard-style ForbiddenException through with its own code', () => {
    const { status, body } = invoke(
      new ForbiddenException({
        code: 'INSUFFICIENT_SCOPE',
        message: 'The token lacks a required scope.',
      }),
    );

    expect(status).toBe(403);
    expect(body?.code).toBe('INSUFFICIENT_SCOPE');
    expect(typeof body?.correlationId).toBe('string');
  });

  it('turns a ValidationPipe BadRequestException into 400 VALIDATION_FAILED', () => {
    const { status, body } = invoke(
      new BadRequestException({
        statusCode: 400,
        message: ['invoiceId must be shorter than or equal to 128 characters'],
        error: 'Bad Request',
      }),
    );

    expect(status).toBe(400);
    expect(body?.code).toBe('VALIDATION_FAILED');
    expect(body?.details).toHaveProperty('invoiceId');
  });

  it.each([
    [new NotFoundException(), 404, 'NOT_FOUND'],
    [new ForbiddenException(), 403, 'FORBIDDEN'],
    [new MethodNotAllowedException(), 405, 'METHOD_NOT_ALLOWED'],
  ])(
    'preserves the status of a non-coded HttpException (%#)',
    (exception, status, code) => {
      const captured = invoke(exception);

      expect(captured.status).toBe(status);
      expect(captured.body?.code).toBe(code);
      expect(typeof captured.body?.message).toBe('string');
      expect(typeof captured.body?.correlationId).toBe('string');
      const serialised = JSON.stringify(captured.body);
      expect(serialised).not.toContain('stack');
      expect(serialised).not.toContain('sql');
      expect(serialised).not.toContain('query');
    },
  );

  it('answers 500 INTERNAL for a raw error and leaks no stack, sql or query', () => {
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    const { status, body } = invoke(new Error('boom'));

    expect(status).toBe(500);
    expect(body?.code).toBe('INTERNAL');
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain('stack');
    expect(serialised).not.toContain('sql');
    expect(serialised).not.toContain('query');
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('keeps a 5xx HttpException on the generic INTERNAL path', () => {
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    const { status, body } = invoke(
      new InternalServerErrorException('connection string leaked'),
    );

    expect(status).toBe(500);
    expect(body?.code).toBe('INTERNAL');
    expect(JSON.stringify(body)).not.toContain('connection string leaked');
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});
