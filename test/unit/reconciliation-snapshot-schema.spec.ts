import { parseReconciliationSnapshot } from '../../src/treasury/schemas/reconciliation-snapshot.schema';

const PROGRAM_ID = '11111111-2222-3333-4444-555555555555';

function validSnapshot(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    messageId: 'snap-00000001',
    programId: PROGRAM_ID,
    version: 1,
    effectiveAt: '2026-01-01T00:00:00.000Z',
    currency: 'USD',
    creditLimitMinor: '1000',
    reservedMinor: '500',
    acknowledgement: { kind: 'EXPLICIT', reservationIds: [] },
    ...overrides,
  };
}

function encode(snapshot: unknown): Buffer {
  return Buffer.from(JSON.stringify(snapshot));
}

describe('parseReconciliationSnapshot', () => {
  it('parses a valid EXPLICIT snapshot from a buffer', () => {
    const result = parseReconciliationSnapshot(
      encode(
        validSnapshot({
          acknowledgement: {
            kind: 'EXPLICIT',
            reservationIds: ['TRSY-1'],
          },
          correlationId: 'corr-1',
        }),
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.snapshot.programId).toBe(PROGRAM_ID);
    expect(result.snapshot.version).toBe(1n);
    expect(result.snapshot.creditLimitMinor).toBe(1000n);
    expect(result.snapshot.reservedMinor).toBe(500n);
    expect(result.snapshot.correlationId).toBe('corr-1');
    expect(result.snapshot.acknowledgement).toEqual({
      kind: 'EXPLICIT',
      reservationReferences: ['TRSY-1'],
      ingestedThrough: null,
    });
  });

  it('parses a valid WATERMARK snapshot from a string', () => {
    const result = parseReconciliationSnapshot(
      JSON.stringify(
        validSnapshot({
          version: 0,
          acknowledgement: {
            kind: 'WATERMARK',
            ingestedThrough: '2026-02-01T00:00:00.000Z',
          },
        }),
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.snapshot.version).toBe(0n);
    expect(result.snapshot.acknowledgement?.kind).toBe('WATERMARK');
    expect(result.snapshot.acknowledgement?.ingestedThrough).toEqual(
      new Date('2026-02-01T00:00:00.000Z'),
    );
  });

  it('treats a missing or null acknowledgement as no marker', () => {
    const missing = validSnapshot();
    delete missing.acknowledgement;
    const withoutMarker = parseReconciliationSnapshot(encode(missing));
    expect(withoutMarker.ok).toBe(true);
    if (withoutMarker.ok) {
      expect(withoutMarker.snapshot.acknowledgement).toBeNull();
    }

    const explicitNull = validSnapshot({ acknowledgement: null });
    const nullMarker = parseReconciliationSnapshot(encode(explicitNull));
    expect(nullMarker.ok).toBe(true);
    if (nullMarker.ok) {
      expect(nullMarker.snapshot.acknowledgement).toBeNull();
    }
  });

  it('rejects a non-string, non-buffer raw value', () => {
    const result = parseReconciliationSnapshot(42 as unknown as string);
    expect(result).toEqual({
      ok: false,
      reason: 'SCHEMA_INVALID',
      detail: expect.any(String),
    });
  });

  it('rejects null and undefined', () => {
    expect(parseReconciliationSnapshot(null).ok).toBe(false);
    expect(parseReconciliationSnapshot(undefined).ok).toBe(false);
  });

  it('rejects invalid JSON', () => {
    expect(parseReconciliationSnapshot('{ not json').ok).toBe(false);
  });

  it.each([['"a string"'], ['[1,2,3]'], ['null'], ['7']])(
    'rejects a JSON value that is not an object: %s',
    (raw) => {
      expect(parseReconciliationSnapshot(raw).ok).toBe(false);
    },
  );

  it('rejects unexpected top-level properties', () => {
    expect(
      parseReconciliationSnapshot(encode(validSnapshot({ extra: true }))).ok,
    ).toBe(false);
  });

  it('rejects a missing required top-level property', () => {
    const snapshot = validSnapshot();
    delete snapshot.reservedMinor;
    expect(parseReconciliationSnapshot(encode(snapshot)).ok).toBe(false);
  });

  it.each([
    ['messageId non-string', { messageId: 5 }],
    ['messageId too short', { messageId: 'short' }],
    ['messageId too long', { messageId: 'x'.repeat(129) }],
    ['programId not a uuid', { programId: 'nope' }],
    ['version non-number', { version: '1' }],
    ['version non-integer', { version: 1.5 }],
    ['version negative', { version: -1 }],
    ['version above 2^53', { version: 9007199254740992 }],
    ['effectiveAt invalid date', { effectiveAt: 'not-a-date' }],
    ['currency not uppercase-3', { currency: 'usd' }],
    ['currency non-string', { currency: 1 }],
    [
      'creditLimitMinor too many digits',
      { creditLimitMinor: '1'.repeat(20) },
    ],
    [
      'creditLimitMinor overflows signed 64-bit',
      { creditLimitMinor: '9999999999999999999' },
    ],
    ['creditLimitMinor non-string', { creditLimitMinor: 1 }],
    ['reservedMinor too many digits', { reservedMinor: '1'.repeat(20) }],
    ['reservedMinor overflows signed 64-bit', { reservedMinor: '9999999999999999999' }],
    ['reservedMinor non-string', { reservedMinor: 1 }],
    ['correlationId non-string', { correlationId: 5 }],
    ['correlationId too long', { correlationId: 'x'.repeat(129) }],
  ])('rejects a bad top-level field: %s', (_label, override) => {
    expect(parseReconciliationSnapshot(encode(validSnapshot(override))).ok).toBe(
      false,
    );
  });

  it('accepts a null correlationId', () => {
    const result = parseReconciliationSnapshot(
      encode(validSnapshot({ correlationId: null })),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.correlationId).toBeNull();
    }
  });

  it.each([
    ['acknowledgement non-object', { acknowledgement: 'nope' }],
    [
      'acknowledgement unknown kind',
      { acknowledgement: { kind: 'SOMETHING', reservationIds: [] } },
    ],
    [
      'EXPLICIT unexpected property',
      { acknowledgement: { kind: 'EXPLICIT', reservationIds: [], x: 1 } },
    ],
    [
      'EXPLICIT missing reservationIds',
      { acknowledgement: { kind: 'EXPLICIT' } },
    ],
    [
      'EXPLICIT reservationIds non-array',
      { acknowledgement: { kind: 'EXPLICIT', reservationIds: 'x' } },
    ],
    [
      'EXPLICIT reservationIds item non-string',
      { acknowledgement: { kind: 'EXPLICIT', reservationIds: [1] } },
    ],
    [
      'EXPLICIT reservationIds item too long',
      { acknowledgement: { kind: 'EXPLICIT', reservationIds: ['x'.repeat(129)] } },
    ],
    [
      'WATERMARK unexpected property',
      {
        acknowledgement: {
          kind: 'WATERMARK',
          ingestedThrough: '2026-01-01T00:00:00.000Z',
          x: 1,
        },
      },
    ],
    [
      'WATERMARK missing ingestedThrough',
      { acknowledgement: { kind: 'WATERMARK' } },
    ],
    [
      'WATERMARK invalid ingestedThrough',
      { acknowledgement: { kind: 'WATERMARK', ingestedThrough: 'nope' } },
    ],
  ])('rejects a bad acknowledgement: %s', (_label, override) => {
    expect(parseReconciliationSnapshot(encode(validSnapshot(override))).ok).toBe(
      false,
    );
  });

  it('rejects an EXPLICIT marker with too many reservation references', () => {
    const reservationIds = Array.from({ length: 10_001 }, (_, index) =>
      `ref-${index}`,
    );
    expect(
      parseReconciliationSnapshot(
        encode(
          validSnapshot({
            acknowledgement: { kind: 'EXPLICIT', reservationIds },
          }),
        ),
      ).ok,
    ).toBe(false);
  });

  it('accepts a 19-digit reservedMinor without overflowing', () => {
    const result = parseReconciliationSnapshot(
      encode(validSnapshot({ reservedMinor: '9223372036854775807' })),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.reservedMinor).toBe(9223372036854775807n);
    }
  });
});
