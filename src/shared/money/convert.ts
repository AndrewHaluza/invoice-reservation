import { Money, money } from './money';

export const RATE_SCALE = 10n ** 10n;

export function scaleRate(rate: string): bigint {
  if (!/^\d{1,10}(\.\d{1,10})?$/.test(rate)) {
    throw new TypeError(`invalid rate: ${rate}`);
  }

  const dot = rate.indexOf('.');
  const intPart = dot === -1 ? rate : rate.slice(0, dot);
  const fracPart = dot === -1 ? '' : rate.slice(dot + 1);
  const scaled = BigInt(intPart + fracPart.padEnd(10, '0'));

  if (scaled === 0n) {
    throw new TypeError('rate must not be zero');
  }

  return scaled;
}

export function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new TypeError('denominator must be positive');
  }

  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const absRemainder = remainder < 0n ? -remainder : remainder;

  if (2n * absRemainder >= denominator) {
    return numerator < 0n ? quotient - 1n : quotient + 1n;
  }

  return quotient;
}

export type ConversionOutcome =
  | { readonly kind: 'converted'; readonly amount: Money }
  | { readonly kind: 'roundsToZero' };

export function convert(
  amount: Money,
  targetCurrency: string,
  scaledRate: bigint,
): ConversionOutcome {
  const result = roundHalfUp(amount.minor * scaledRate, RATE_SCALE);

  if (result === 0n && amount.minor !== 0n) {
    return { kind: 'roundsToZero' };
  }

  return { kind: 'converted', amount: money(result, targetCurrency) };
}
