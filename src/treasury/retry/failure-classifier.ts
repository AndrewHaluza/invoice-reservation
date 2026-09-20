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

const TRANSIENT_SQLSTATE_CODES: ReadonlySet<string> = new Set([
  '55P03',
  '40P01',
  '40001',
  '53300',
  '57014',
  '08000',
  '08003',
  '08006',
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

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string') {
    return direct;
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
 * True only for the explicitly recognised infrastructure failures (Postgres
 * SQLSTATEs and Node network codes). Unknown errors are retried too, but they
 * are NOT transient in this sense: after the retry bound a recognised transient
 * failure must never be quarantined (FR-035), whereas an unrecognised one may
 * be, so the distinction has to survive past `withRetry`.
 */
export function isTransientFailure(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code !== undefined &&
    (TRANSIENT_SQLSTATE_CODES.has(code) || TRANSIENT_NETWORK_CODES.has(code))
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
