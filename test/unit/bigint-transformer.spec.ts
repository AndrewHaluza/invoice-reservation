import { bigintTransformer } from '../../src/capacity/infrastructure/entities/bigint.transformer';

describe('bigintTransformer', () => {
  it('round-trips a value that Number would corrupt', () => {
    expect(bigintTransformer.from('9007199254740993')).toBe(9007199254740993n);
    expect(bigintTransformer.to(9007199254740993n)).toBe('9007199254740993');
  });

  it('passes null through in both directions', () => {
    expect(bigintTransformer.to(null)).toBeNull();
    expect(bigintTransformer.from(null)).toBeNull();
  });

  it('handles negative values', () => {
    expect(bigintTransformer.to(-1n)).toBe('-1');
    expect(bigintTransformer.from('-1')).toBe(-1n);
  });
});
