export type RefusalCode =
  | 'POSITION_UNVERIFIED'
  | 'PROGRAM_OVER_LIMIT'
  | 'FX_RATE_UNAVAILABLE'
  | 'AMOUNT_ROUNDS_TO_ZERO'
  | 'INSUFFICIENT_CAPACITY'
  | 'DUPLICATE_INVOICE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_EXPIRED'
  | 'REQUEST_IN_FLIGHT'
  | 'INVALID_AMOUNT'
  | 'CURRENCY_MISMATCH'
  | 'RESERVATION_TERMINAL'
  | 'RELEASE_EXCEEDS_RESERVED'
  | 'NOT_FOUND';

export const REFUSAL_CODES = [
  'POSITION_UNVERIFIED',
  'PROGRAM_OVER_LIMIT',
  'FX_RATE_UNAVAILABLE',
  'AMOUNT_ROUNDS_TO_ZERO',
  'INSUFFICIENT_CAPACITY',
  'DUPLICATE_INVOICE',
  'IDEMPOTENCY_CONFLICT',
  'IDEMPOTENCY_EXPIRED',
  'REQUEST_IN_FLIGHT',
  'INVALID_AMOUNT',
  'CURRENCY_MISMATCH',
  'RESERVATION_TERMINAL',
  'RELEASE_EXCEEDS_RESERVED',
  'NOT_FOUND',
] as const satisfies readonly RefusalCode[];

/** A refusal that changed nothing. Carries no internal state. */
export class CapacityRefusal extends Error {
  constructor(
    readonly code: RefusalCode,
    readonly details?: Readonly<Record<string, string>>,
  ) {
    super(code);
    this.name = 'CapacityRefusal';
  }
}
