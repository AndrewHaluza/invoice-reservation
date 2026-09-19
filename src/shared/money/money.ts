export type CurrencyCode = string & { readonly __brand: 'CurrencyCode' };

export interface Money {
  readonly minor: bigint;
  readonly currency: CurrencyCode;
}

export class CurrencyMismatchError extends Error {}

export function currency(code: string): CurrencyCode {
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new TypeError(`invalid currency code: ${code}`);
  }
  return code as CurrencyCode;
}

export function money(minor: bigint, code: string | CurrencyCode): Money {
  if (typeof minor === 'number') {
    throw new TypeError('money() requires bigint minor units, received number');
  }
  return { minor, currency: currency(code) };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(
      `currency mismatch: ${a.currency} !== ${b.currency}`,
    );
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { minor: a.minor + b.minor, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { minor: a.minor - b.minor, currency: a.currency };
}

export function negate(a: Money): Money {
  return { minor: -a.minor, currency: a.currency };
}

export function isZero(a: Money): boolean {
  return a.minor === 0n;
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.minor < b.minor) {
    return -1;
  }
  if (a.minor > b.minor) {
    return 1;
  }
  return 0;
}

export function toDecimalString(a: Money, minorUnitDigits: number): string {
  const negative = a.minor < 0n;
  const abs = negative ? -a.minor : a.minor;
  const digits = abs.toString();

  if (minorUnitDigits === 0) {
    return negative ? `-${digits}` : digits;
  }

  const padded = digits.padStart(minorUnitDigits + 1, '0');
  const cut = padded.length - minorUnitDigits;
  const whole = padded.slice(0, cut);
  const fraction = padded.slice(cut);
  const rendered = `${whole}.${fraction}`;
  return negative ? `-${rendered}` : rendered;
}

export function fromDecimalString(
  value: string,
  code: string,
  minorUnitDigits: number,
): Money {
  if (!/^-?\d{1,19}(\.\d+)?$/.test(value)) {
    throw new TypeError(`invalid decimal string: ${value}`);
  }

  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const dot = unsigned.indexOf('.');
  const intPart = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fracPart = dot === -1 ? '' : unsigned.slice(dot + 1);

  if (fracPart.length > minorUnitDigits) {
    throw new TypeError(
      `too many fractional digits for ${minorUnitDigits}-minor-unit currency: ${value}`,
    );
  }

  const significantInt = intPart.replace(/^0+/, '');
  if (significantInt.length + fracPart.length > 19) {
    throw new TypeError(`too many significant digits: ${value}`);
  }

  const paddedFrac = fracPart.padEnd(minorUnitDigits, '0');
  const combined = intPart + paddedFrac;
  const minor = BigInt(combined === '' ? '0' : combined);

  return money(negative ? -minor : minor, code);
}
