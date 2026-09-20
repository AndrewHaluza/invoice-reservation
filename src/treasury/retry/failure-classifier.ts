import { scheduler } from 'node:timers/promises';

export type FailureClass = 'TRANSIENT' | 'PERMANENT';

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export class PermanentTreasuryError extends Error {
  constructor(message = 'permanent treasury failure') {
    super(message);
    this.name = 'PermanentTreasuryError';
  }
}

export class RetryExhaustedError extends Error {
  constructor(readonly lastError: unknown) {
    super('retry attempts exhausted');
    this.name = 'RetryExhaustedError';
  }
}

// Postgres SQLSTATE codes that represent infrastructure failures worth retrying,
// rather than bad data. Codes are grouped by their two-character class so a new
// code in a transient class is covered without an explicit entry:
//   - 08 Connection Exception (all)
//   - 40 Transaction Rollback: only the contention codes, not integrity ones
//   - 53 Insufficient Resources (all)
//   - 55 Object Not In Prerequisite State (all)
//   - 57 Operator Intervention (all)
//   - 58 System Error (all)
const TRANSIENT_SQLSTATE_CLASSES: ReadonlySet<string> = new Set([
  '08',
  '53',
  '55',
  '57',
  '58',
]);

// The two transaction-rollback codes that mean contention, not bad data.
const TRANSIENT_CLASS40_CODES: ReadonlySet<string> = new Set(['40001', '40P01']);

const TRANSIENT_SQLSTATE_CODES: ReadonlySet<string> = new Set([
  '55P03',
  '57014',
  ...TRANSIENT_CLASS40_CODES,
]);

const TRANSIENT_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EPIPE',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

// The pg-pool and pg-client connection failures that FR-035/T074 name as
// transient carry no `code` at all (pg-pool throws `timeout exceeded when
// trying to connect`; a dropped socket surfaces as `Connection terminated
// unexpectedly` / `Client has encountered a connection error and is not
// queryable`). Recognise them by message so a DB/network blip is retried and
// left uncommitted rather than quarantined and silently dropped.
const TRANSIENT_ERROR_MESSAGES: ReadonlyArray<RegExp> = [
  /timeout exceeded when trying to connect/i,
  /connection terminated unexpectedly/i,
  /client has encountered a connection error/i,
  /connection refused/i,
  /socket hang up/i,
  /terminating connection due to/i,
  /connection to .* has been closed/i,
  /connection pool/i,
  /too many clients/i,
  /remaining connection slots/i,
  /canceling statement due to/i,
  /could not connect/i,
];

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string') {
    return direct;
  }

  // TypeORM wraps the underlying pg error in QueryFailedError without copying
  // its `code`; the driver error is what carries the SQLSTATE.
  const driverError = (error as { driverError?: unknown }).driverError;
  if (typeof driverError === 'object' && driverError !== null) {
    const driverCode = (driverError as { code?: unknown }).code;
    if (typeof driverCode === 'string') {
      return driverCode;
    }
  }

  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause === 'object' && cause !== null) {
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === 'string') {
      return causeCode;
    }
  }

  return undefined;
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const direct = (error as { message?: unknown }).message;
  if (typeof direct === 'string') {
    return direct;
  }

  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause === 'object' && cause !== null) {
    const causeMessage = (cause as { message?: unknown }).message;
    if (typeof causeMessage === 'string') {
      return causeMessage;
    }
  }

  return undefined;
}

export function classifyFailure(error: unknown): FailureClass {
  if (error instanceof PermanentTreasuryError) {
    return 'PERMANENT';
  }

  if (isTransientFailure(error)) {
    return 'TRANSIENT';
  }

  return 'TRANSIENT';
}

/**
 * True only for the recognised infrastructure failures (Postgres SQLSTATEs,
 * Node network codes, and the code-less pg-pool/pg-client connection errors).
 * Unknown errors are retried too, but they are NOT transient in this sense:
 * after the retry bound a recognised transient failure must never be
 * quarantined (FR-035), whereas an unrecognised one may be, so the distinction
 * has to survive past `withRetry`.
 */
export function isTransientFailure(error: unknown): boolean {
  const code = errorCode(error);
  if (code !== undefined) {
    if (
      TRANSIENT_SQLSTATE_CODES.has(code) ||
      TRANSIENT_NETWORK_CODES.has(code)
    ) {
      return true;
    }
    const codeClass = code.slice(0, 2);
    if (
      code.length === 5 &&
      TRANSIENT_SQLSTATE_CLASSES.has(codeClass)
    ) {
      return true;
    }
  }

  const message = errorMessage(error);
  return (
    message !== undefined &&
    TRANSIENT_ERROR_MESSAGES.some((pattern) => pattern.test(message))
  );
}

const sleep = (delayMs: number): Promise<void> => scheduler.wait(delayMs);

export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void,
): Promise<T> {
  let attempt = 1;

  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (classifyFailure(error) === 'PERMANENT') {
        throw error;
      }

      if (attempt >= policy.maxAttempts) {
        throw new RetryExhaustedError(error);
      }

      const delayMs = Math.min(
        policy.maxDelayMs,
        policy.baseDelayMs * 2 ** (attempt - 1),
      );
      onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
      attempt += 1;
    }
  }
}
