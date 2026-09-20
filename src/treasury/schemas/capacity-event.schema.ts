import {
  CapacityEvent,
  CapacityEventType,
} from '../../shared/treasury/capacity-event';

export type ParseResult =
  | { readonly ok: true; readonly event: CapacityEvent }
  | {
      readonly ok: false;
      readonly reason: 'SCHEMA_INVALID';
      readonly detail: string;
    };

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const AMOUNT_MINOR_PATTERN = /^-?[0-9]{1,19}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
// The widest value the BIGINT columns can hold. The 19-digit pattern above
// admits values beyond this, and a value that overflows on insert would be an
// unrecognised (initially retried) failure rather than a permanent schema
// rejection, so bound the range explicitly here.
const BIGINT_MAX = 9223372036854775807n;
const BIGINT_MIN = -9223372036854775808n;

const EVENT_TYPES: readonly CapacityEventType[] = [
  'LIMIT_CHANGED',
  'RESERVATION_BOOKED',
  'RESERVATION_RELEASED',
];

const EVENT_KEYS = [
  'messageId',
  'programId',
  'version',
  'effectiveAt',
  'type',
  'payload',
  'correlationId',
] as const;

const EVENT_REQUIRED = [
  'messageId',
  'programId',
  'version',
  'effectiveAt',
  'type',
  'payload',
] as const;

const PAYLOAD_KEYS = [
  'amountMinor',
  'currency',
  'reservationReference',
] as const;

const PAYLOAD_REQUIRED = ['amountMinor', 'currency'] as const;

interface Invalid {
  readonly ok: false;
  readonly reason: 'SCHEMA_INVALID';
  readonly detail: string;
}

const invalid = (detail: string): Invalid => ({
  ok: false,
  reason: 'SCHEMA_INVALID',
  detail,
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

function missingKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): string[] {
  return required.filter((key) => !Object.hasOwn(value, key));
}

function decode(raw: Buffer | string | null | undefined): string | Invalid {
  if (typeof raw === 'string') {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString('utf8');
  }
  return invalid('event value must be a string or buffer');
}

function parseCorrelationId(
  value: Record<string, unknown>,
): string | null | Invalid {
  if (!Object.hasOwn(value, 'correlationId') || value.correlationId === null) {
    return null;
  }
  const correlationId = value.correlationId;
  if (typeof correlationId !== 'string' || correlationId.length > 128) {
    return invalid('correlationId must be a string of at most 128 characters');
  }
  return correlationId;
}

function parsePayload(value: unknown): CapacityEvent['payload'] | Invalid {
  if (!isPlainObject(value)) {
    return invalid('payload must be an object');
  }
  const extra = unknownKeys(value, PAYLOAD_KEYS);
  if (extra.length > 0) {
    return invalid(`payload has unexpected properties: ${extra.join(', ')}`);
  }
  const missing = missingKeys(value, PAYLOAD_REQUIRED);
  if (missing.length > 0) {
    return invalid(`payload is missing properties: ${missing.join(', ')}`);
  }

  const amountMinor = value.amountMinor;
  if (typeof amountMinor !== 'string' || !AMOUNT_MINOR_PATTERN.test(amountMinor)) {
    return invalid('payload.amountMinor must match ^-?[0-9]{1,19}$');
  }
  const amountValue = BigInt(amountMinor);
  if (amountValue > BIGINT_MAX || amountValue < BIGINT_MIN) {
    return invalid('payload.amountMinor is outside the signed 64-bit range');
  }

  const currency = value.currency;
  if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
    return invalid('payload.currency must match ^[A-Z]{3}$');
  }

  let reservationReference: string | null = null;
  if (
    Object.hasOwn(value, 'reservationReference') &&
    value.reservationReference !== null
  ) {
    if (typeof value.reservationReference !== 'string') {
      return invalid('payload.reservationReference must be a string or null');
    }
    reservationReference = value.reservationReference;
  }

  return {
    amountMinor: amountValue,
    currency,
    reservationReference,
  };
}

export function parseCapacityEvent(
  raw: Buffer | string | null | undefined,
): ParseResult {
  const decoded = decode(raw);
  if (typeof decoded !== 'string') {
    return decoded;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return invalid('event value is not valid JSON');
  }

  if (!isPlainObject(parsed)) {
    return invalid('event must be a JSON object');
  }

  const extra = unknownKeys(parsed, EVENT_KEYS);
  if (extra.length > 0) {
    return invalid(`event has unexpected properties: ${extra.join(', ')}`);
  }
  const missing = missingKeys(parsed, EVENT_REQUIRED);
  if (missing.length > 0) {
    return invalid(`event is missing properties: ${missing.join(', ')}`);
  }

  const messageId = parsed.messageId;
  if (
    typeof messageId !== 'string' ||
    messageId.length < 8 ||
    messageId.length > 128
  ) {
    return invalid('messageId must be a string of 8 to 128 characters');
  }

  const programId = parsed.programId;
  if (typeof programId !== 'string' || !UUID_PATTERN.test(programId)) {
    return invalid('programId must be a UUID');
  }

  const version = parsed.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    return invalid('version must be an integer greater than or equal to 0');
  }

  const effectiveAt = parsed.effectiveAt;
  if (typeof effectiveAt !== 'string' || Number.isNaN(Date.parse(effectiveAt))) {
    return invalid('effectiveAt must be a valid date-time string');
  }

  const type = parsed.type;
  if (
    typeof type !== 'string' ||
    !(EVENT_TYPES as readonly string[]).includes(type)
  ) {
    return invalid('type is not a recognised capacity event type');
  }

  const correlationId = parseCorrelationId(parsed);
  if (typeof correlationId !== 'string' && correlationId !== null) {
    return correlationId;
  }

  const payload = parsePayload(parsed.payload);
  if ('ok' in payload) {
    return payload;
  }

  return {
    ok: true,
    event: {
      messageId,
      programId,
      version: BigInt(version),
      effectiveAt: new Date(effectiveAt),
      correlationId,
      type: type as CapacityEventType,
      payload,
    },
  };
}
