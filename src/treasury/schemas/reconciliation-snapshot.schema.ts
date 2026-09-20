import {
  ReconciliationSnapshot,
  SnapshotMarker,
} from '../../shared/treasury/reconciliation-snapshot';

export type SnapshotParseResult =
  | { readonly ok: true; readonly snapshot: ReconciliationSnapshot }
  | {
      readonly ok: false;
      readonly reason: 'SCHEMA_INVALID';
      readonly detail: string;
    };

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const NON_NEGATIVE_MINOR_PATTERN = /^[0-9]{1,19}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
// The widest value the BIGINT columns can hold. The 19-digit pattern above
// admits values beyond this, and a value that overflows on insert would
// otherwise surface as an unrecognised (initially retried) failure rather than
// a permanent schema rejection.
const BIGINT_MAX = 9223372036854775807n;

const SNAPSHOT_KEYS = [
  'messageId',
  'programId',
  'version',
  'effectiveAt',
  'correlationId',
  'currency',
  'creditLimitMinor',
  'reservedMinor',
  'acknowledgement',
] as const;

// `acknowledgement` is deliberately NOT required here: a snapshot without a
// marker is a valid message with an invalid effect, and FR-011b classifies it
// `MISSING_ACK_MARKER` rather than a schema failure.
const SNAPSHOT_REQUIRED = [
  'messageId',
  'programId',
  'version',
  'effectiveAt',
  'currency',
  'creditLimitMinor',
  'reservedMinor',
] as const;

const MAX_RESERVATION_REFERENCES = 10_000;

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
  return invalid('snapshot value must be a string or buffer');
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

function parseMinor(
  value: Record<string, unknown>,
  key: string,
): bigint | Invalid {
  const amount = value[key];
  if (
    typeof amount !== 'string' ||
    !NON_NEGATIVE_MINOR_PATTERN.test(amount)
  ) {
    return invalid(`${key} must match ^[0-9]{1,19}$`);
  }
  const parsed = BigInt(amount);
  if (parsed > BIGINT_MAX) {
    return invalid(`${key} is outside the signed 64-bit range`);
  }
  return parsed;
}

function parseExplicit(
  value: Record<string, unknown>,
): SnapshotMarker | Invalid {
  const extra = unknownKeys(value, ['kind', 'reservationIds']);
  if (extra.length > 0) {
    return invalid(
      `acknowledgement has unexpected properties: ${extra.join(', ')}`,
    );
  }
  if (!Object.hasOwn(value, 'reservationIds')) {
    return invalid('acknowledgement is missing properties: reservationIds');
  }
  const reservationIds = value.reservationIds;
  if (!Array.isArray(reservationIds)) {
    return invalid('acknowledgement.reservationIds must be an array');
  }
  if (reservationIds.length > MAX_RESERVATION_REFERENCES) {
    return invalid(
      `acknowledgement.reservationIds must hold at most ${MAX_RESERVATION_REFERENCES} items`,
    );
  }
  const references: string[] = [];
  for (const reference of reservationIds) {
    if (typeof reference !== 'string' || reference.length > 128) {
      return invalid(
        'acknowledgement.reservationIds items must be strings of at most 128 characters',
      );
    }
    references.push(reference);
  }
  return {
    kind: 'EXPLICIT',
    reservationReferences: references,
    ingestedThrough: null,
  };
}

function parseWatermark(
  value: Record<string, unknown>,
): SnapshotMarker | Invalid {
  const extra = unknownKeys(value, ['kind', 'ingestedThrough']);
  if (extra.length > 0) {
    return invalid(
      `acknowledgement has unexpected properties: ${extra.join(', ')}`,
    );
  }
  if (!Object.hasOwn(value, 'ingestedThrough')) {
    return invalid('acknowledgement is missing properties: ingestedThrough');
  }
  const ingestedThrough = value.ingestedThrough;
  if (
    typeof ingestedThrough !== 'string' ||
    Number.isNaN(Date.parse(ingestedThrough))
  ) {
    return invalid('acknowledgement.ingestedThrough must be a valid date-time');
  }
  return {
    kind: 'WATERMARK',
    reservationReferences: null,
    ingestedThrough: new Date(ingestedThrough),
  };
}

function parseAcknowledgement(
  value: Record<string, unknown>,
): SnapshotMarker | null | Invalid {
  if (
    !Object.hasOwn(value, 'acknowledgement') ||
    value.acknowledgement === null
  ) {
    return null;
  }
  const acknowledgement = value.acknowledgement;
  if (!isPlainObject(acknowledgement)) {
    return invalid('acknowledgement must be an object');
  }
  const kind = acknowledgement.kind;
  if (kind !== 'EXPLICIT' && kind !== 'WATERMARK') {
    return invalid('acknowledgement.kind must be EXPLICIT or WATERMARK');
  }
  return kind === 'EXPLICIT'
    ? parseExplicit(acknowledgement)
    : parseWatermark(acknowledgement);
}

function isInvalid(value: unknown): value is Invalid {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ok' in value &&
    (value as { ok?: unknown }).ok === false
  );
}

export function parseReconciliationSnapshot(
  raw: Buffer | string | null | undefined,
): SnapshotParseResult {
  const decoded = decode(raw);
  if (typeof decoded !== 'string') {
    return decoded;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return invalid('snapshot value is not valid JSON');
  }

  if (!isPlainObject(parsed)) {
    return invalid('snapshot must be a JSON object');
  }

  const extra = unknownKeys(parsed, SNAPSHOT_KEYS);
  if (extra.length > 0) {
    return invalid(`snapshot has unexpected properties: ${extra.join(', ')}`);
  }
  const missing = missingKeys(parsed, SNAPSHOT_REQUIRED);
  if (missing.length > 0) {
    return invalid(`snapshot is missing properties: ${missing.join(', ')}`);
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
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 0 ||
    // A JSON number cannot represent an integer above 2^53 exactly, and the
    // `processed_message.version` column is BIGINT: an unbounded value either
    // loses precision silently or throws an out-of-range error that the retry
    // classifier does not recognise as permanent. Reject it here instead.
    version > Number.MAX_SAFE_INTEGER
  ) {
    return invalid(
      'version must be an integer between 0 and 9007199254740991',
    );
  }

  const effectiveAt = parsed.effectiveAt;
  if (typeof effectiveAt !== 'string' || Number.isNaN(Date.parse(effectiveAt))) {
    return invalid('effectiveAt must be a valid date-time string');
  }

  const currency = parsed.currency;
  if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
    return invalid('currency must match ^[A-Z]{3}$');
  }

  const creditLimitMinor = parseMinor(parsed, 'creditLimitMinor');
  if (isInvalid(creditLimitMinor)) {
    return creditLimitMinor;
  }

  const reservedMinor = parseMinor(parsed, 'reservedMinor');
  if (isInvalid(reservedMinor)) {
    return reservedMinor;
  }

  const correlationId = parseCorrelationId(parsed);
  if (isInvalid(correlationId)) {
    return correlationId;
  }

  const acknowledgement = parseAcknowledgement(parsed);
  if (isInvalid(acknowledgement)) {
    return acknowledgement;
  }

  return {
    ok: true,
    snapshot: {
      messageId,
      programId,
      version: BigInt(version),
      effectiveAt: new Date(effectiveAt),
      correlationId,
      currency,
      creditLimitMinor,
      reservedMinor,
      acknowledgement,
    },
  };
}
