import { parseCapacityEvent } from '../../src/treasury/schemas/capacity-event.schema';

const PROGRAM_ID = '11111111-2222-3333-4444-555555555555';

function validEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: 'msg-00000001',
    programId: PROGRAM_ID,
    version: 1,
    effectiveAt: '2026-01-01T00:00:00.000Z',
    type: 'RESERVATION_BOOKED',
    payload: { amountMinor: '100', currency: 'USD' },
    ...overrides,
  };
}

function encode(event: unknown): Buffer {
  return Buffer.from(JSON.stringify(event));
}

describe('parseCapacityEvent', () => {
  it('parses a valid event from a buffer and converts its scalars', () => {
    const result = parseCapacityEvent(encode(validEvent()));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.event.programId).toBe(PROGRAM_ID);
    expect(result.event.version).toBe(1n);
    expect(result.event.effectiveAt).toBeInstanceOf(Date);
    expect(result.event.correlationId).toBeNull();
    expect(result.event.payload.amountMinor).toBe(100n);
    expect(result.event.payload.currency).toBe('USD');
    expect(result.event.payload.reservationReference).toBeNull();
  });

  it('parses a valid event from a string and keeps correlation/reference', () => {
    const result = parseCapacityEvent(
      JSON.stringify(
        validEvent({
          correlationId: 'corr-1',
          version: 0,
          payload: {
            amountMinor: '-5',
            currency: 'EUR',
            reservationReference: 'TRSY-1',
          },
        }),
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.event.version).toBe(0n);
    expect(result.event.correlationId).toBe('corr-1');
    expect(result.event.payload.amountMinor).toBe(-5n);
    expect(result.event.payload.reservationReference).toBe('TRSY-1');
  });

  it('rejects a non-string, non-buffer raw value', () => {
    const result = parseCapacityEvent(42 as unknown as string);
    expect(result).toEqual({
      ok: false,
      reason: 'SCHEMA_INVALID',
      detail: expect.any(String),
    });
  });

  it('rejects null and undefined', () => {
    expect(parseCapacityEvent(null).ok).toBe(false);
    expect(parseCapacityEvent(undefined).ok).toBe(false);
  });

  it('rejects invalid JSON', () => {
    expect(parseCapacityEvent('{ not json').ok).toBe(false);
  });

  it.each([['"a string"'], ['[1,2,3]'], ['null'], ['7']])(
    'rejects a JSON value that is not an object: %s',
    (raw) => {
      expect(parseCapacityEvent(raw).ok).toBe(false);
    },
  );

  it('rejects unexpected top-level properties', () => {
    expect(parseCapacityEvent(encode(validEvent({ extra: true }))).ok).toBe(false);
  });

  it('rejects a missing required top-level property', () => {
    const event = validEvent();
    delete event.type;
    expect(parseCapacityEvent(encode(event)).ok).toBe(false);
  });

  it.each([
    ['messageId non-string', { messageId: 5 }],
    ['messageId too short', { messageId: 'short' }],
    ['messageId too long', { messageId: 'x'.repeat(129) }],
    ['programId non-string', { programId: 5 }],
    ['programId not a uuid', { programId: 'nope' }],
    ['version non-number', { version: '1' }],
    ['version non-integer', { version: 1.5 }],
    ['version negative', { version: -1 }],
    ['effectiveAt non-string', { effectiveAt: 1 }],
    ['effectiveAt invalid date', { effectiveAt: 'not-a-date' }],
    ['type unknown', { type: 'SOMETHING_ELSE' }],
    ['type non-string', { type: 5 }],
  ])('rejects a bad top-level field: %s', (_label, override) => {
    expect(parseCapacityEvent(encode(validEvent(override))).ok).toBe(false);
  });

  it('treats a null correlationId as null', () => {
    const result = parseCapacityEvent(encode(validEvent({ correlationId: null })));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.correlationId).toBeNull();
    }
  });

  it.each([
    ['correlationId non-string', { correlationId: 5 }],
    ['correlationId too long', { correlationId: 'x'.repeat(129) }],
  ])('rejects a bad correlationId: %s', (_label, override) => {
    expect(parseCapacityEvent(encode(validEvent(override))).ok).toBe(false);
  });

  it.each([
    ['payload non-object', { payload: 'nope' }],
    ['payload extra property', { payload: { amountMinor: '1', currency: 'USD', x: 1 } }],
    ['payload missing currency', { payload: { amountMinor: '1' } }],
    ['amountMinor non-string', { payload: { amountMinor: 1, currency: 'USD' } }],
    ['amountMinor too many digits', { payload: { amountMinor: '1'.repeat(40), currency: 'USD' } }],
    ['amountMinor overflows signed 64-bit', { payload: { amountMinor: '9999999999999999999', currency: 'USD' } }],
    ['amountMinor underflows signed 64-bit', { payload: { amountMinor: '-9999999999999999999', currency: 'USD' } }],
    ['currency non-string', { payload: { amountMinor: '1', currency: 1 } }],
    ['currency not uppercase-3', { payload: { amountMinor: '1', currency: 'usd' } }],
    ['reservationReference non-string', { payload: { amountMinor: '1', currency: 'USD', reservationReference: 5 } }],
  ])('rejects a bad payload: %s', (_label, override) => {
    expect(parseCapacityEvent(encode(validEvent(override))).ok).toBe(false);
  });

  it('accepts a null reservationReference', () => {
    const result = parseCapacityEvent(
      encode(validEvent({ payload: { amountMinor: '1', currency: 'USD', reservationReference: null } })),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.payload.reservationReference).toBeNull();
    }
  });

  it('accepts a 19-digit amountMinor without overflowing', () => {
    const result = parseCapacityEvent(
      encode(validEvent({ payload: { amountMinor: '9223372036854775807', currency: 'USD' } })),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.payload.amountMinor).toBe(9223372036854775807n);
    }
  });
});
