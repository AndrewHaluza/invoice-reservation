import { randomUUID } from 'node:crypto';

export const CORRELATION_HEADER = 'x-correlation-id';
export const MAX_CORRELATION_LENGTH = 128;

const CORRELATION_PATTERN = /^[A-Za-z0-9._:-]+$/;

export function sanitiseCorrelationId(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  if (raw.length < 1 || raw.length > MAX_CORRELATION_LENGTH) {
    return null;
  }
  if (!CORRELATION_PATTERN.test(raw)) {
    return null;
  }
  return raw;
}

export function resolveCorrelationId(raw: unknown): string {
  return sanitiseCorrelationId(raw) ?? randomUUID();
}

export function correlationFromKafkaHeaders(
  headers: Record<string, Buffer | string | undefined>,
): string {
  const raw = headers[CORRELATION_HEADER];
  const value = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
  return resolveCorrelationId(value);
}
