import { money } from '../../src/shared/money/money';
import { convert, roundHalfUp, scaleRate } from '../../src/shared/money/convert';

describe('roundHalfUp', () => {
  it('rounds halves away from zero for both signs', () => {
    expect(roundHalfUp(5n, 10n)).toBe(1n);
    expect(roundHalfUp(-5n, 10n)).toBe(-1n);
  });

  it('rounds below and above the half point', () => {
    expect(roundHalfUp(4n, 10n)).toBe(0n);
    expect(roundHalfUp(15n, 10n)).toBe(2n);
  });
});

describe('scaleRate', () => {
  it('scales decimal rates with ten fractional digits', () => {
    expect(scaleRate('1.0850000000')).toBe(10850000000n);
    expect(scaleRate('1.085')).toBe(10850000000n);
  });

  it('rejects a zero rate', () => {
    expect(() => scaleRate('0')).toThrow();
  });

  it('rejects more than ten fractional digits', () => {
    expect(() => scaleRate('1.08500000001')).toThrow();
  });
});

describe('convert', () => {
  it('reports a non-zero amount that rounds to zero', () => {
    expect(convert(money(1n, 'JPY'), 'USD', scaleRate('0.0067'))).toEqual({
      kind: 'roundsToZero',
    });
  });

  it('converts a genuine zero to zero', () => {
    const result = convert(money(0n, 'JPY'), 'USD', scaleRate('0.0067'));
    expect(result.kind).toBe('converted');
    if (result.kind === 'converted') {
      expect(result.amount.minor).toBe(0n);
      expect(result.amount.currency).toBe('USD');
    }
  });

  it('converts an amount at the scaled rate', () => {
    const result = convert(
      money(1_000_000_00n, 'EUR'),
      'USD',
      scaleRate('1.0850000000'),
    );
    expect(result.kind).toBe('converted');
    if (result.kind === 'converted') {
      expect(result.amount.minor).toBe(108500000n);
    }
  });
});
