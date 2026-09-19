import {
  CurrencyMismatchError,
  add,
  compare,
  currency,
  fromDecimalString,
  isZero,
  money,
  negate,
  subtract,
  toDecimalString,
} from '../../src/shared/money/money';

describe('money', () => {
  it('rejects construction from number', () => {
    expect(() => money(100 as unknown as bigint, 'USD')).toThrow(TypeError);
  });

  it('rejects malformed currency codes', () => {
    expect(() => currency('usd')).toThrow();
    expect(() => currency('US')).toThrow();
    expect(() => currency('USDD')).toThrow();
    expect(() => currency('US1')).toThrow();
  });

  it('rejects arithmetic across currencies', () => {
    expect(() => add(money(1n, 'USD'), money(1n, 'EUR'))).toThrow(
      CurrencyMismatchError,
    );
  });

  it('round trips one above Number.MAX_SAFE_INTEGER', () => {
    const m = money(9007199254740993n, 'USD');
    expect(fromDecimalString(toDecimalString(m, 2), 'USD', 2)).toEqual(m);
  });

  it('renders negative minor units', () => {
    expect(toDecimalString(money(-1n, 'USD'), 2)).toBe('-0.01');
  });

  it('renders zero minor units', () => {
    expect(toDecimalString(money(0n, 'USD'), 2)).toBe('0.00');
  });

  it('rejects excess fractional digits on parse', () => {
    expect(() => fromDecimalString('1.234', 'USD', 2)).toThrow(TypeError);
  });

  it('returns a new object without mutating operands', () => {
    const a = money(100n, 'USD');
    const b = money(250n, 'USD');
    const aCopy = { ...a };
    const bCopy = { ...b };

    const result = add(a, b);

    expect(result).not.toBe(a);
    expect(result).not.toBe(b);
    expect(result.minor).toBe(350n);
    expect(a).toEqual(aCopy);
    expect(b).toEqual(bCopy);
  });
});

describe('money arithmetic and ordering', () => {
  it('subtracts same-currency amounts and rejects a mismatch', () => {
    expect(subtract(money(250n, 'USD'), money(100n, 'USD'))).toEqual(
      money(150n, 'USD'),
    );
    expect(() => subtract(money(1n, 'USD'), money(1n, 'EUR'))).toThrow(
      CurrencyMismatchError,
    );
  });

  it('negates without mutating its argument', () => {
    const a = money(100n, 'USD');
    expect(negate(a)).toEqual(money(-100n, 'USD'));
    expect(a).toEqual(money(100n, 'USD'));
  });

  it('detects zero', () => {
    expect(isZero(money(0n, 'USD'))).toBe(true);
    expect(isZero(money(1n, 'USD'))).toBe(false);
  });

  it('orders same-currency amounts and rejects a mismatch', () => {
    expect(compare(money(1n, 'USD'), money(2n, 'USD'))).toBe(-1);
    expect(compare(money(2n, 'USD'), money(1n, 'USD'))).toBe(1);
    expect(compare(money(2n, 'USD'), money(2n, 'USD'))).toBe(0);
    expect(() => compare(money(1n, 'USD'), money(1n, 'EUR'))).toThrow(
      CurrencyMismatchError,
    );
  });

  it('renders whole-unit currencies without a decimal point', () => {
    expect(toDecimalString(money(1234n, 'JPY'), 0)).toBe('1234');
    expect(toDecimalString(money(-1n, 'JPY'), 0)).toBe('-1');
  });

  it('rejects malformed and over-precise decimal strings', () => {
    expect(() => fromDecimalString('not-a-number', 'USD', 2)).toThrow(TypeError);
    expect(() => fromDecimalString('12345678901234567890', 'USD', 2)).toThrow(
      TypeError,
    );
    expect(() => fromDecimalString('1234567890123456789.0', 'USD', 2)).toThrow(
      TypeError,
    );
    expect(() => fromDecimalString('1.2.3', 'USD', 2)).toThrow(TypeError);
  });

  it('parses a negative decimal string back to negative minor units', () => {
    expect(fromDecimalString('-0.01', 'USD', 2)).toEqual(money(-1n, 'USD'));
  });
});
