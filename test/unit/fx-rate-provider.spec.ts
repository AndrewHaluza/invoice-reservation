import { StaticRateProvider } from '../../src/fx';

describe('StaticRateProvider', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  it('resolves the seeded EUR→USD rate and scales it without a float', async () => {
    const provider = new StaticRateProvider([
      {
        base: 'EUR',
        quote: 'USD',
        rate: '1.0850000000',
        effectiveAt: new Date(0),
        source: 'seed',
      },
    ]);

    const rate = await provider.rateFor('EUR', 'USD', now);

    expect(rate).not.toBeNull();
    expect(rate?.scaledRate).toBe(10850000000n);
    expect(rate?.rate).toBe('1.0850000000');
  });

  it('returns null for a pair with no stored rate', async () => {
    const provider = new StaticRateProvider([
      {
        base: 'EUR',
        quote: 'USD',
        rate: '1.0850000000',
        effectiveAt: new Date(0),
        source: 'seed',
      },
    ]);

    await expect(provider.rateFor('EUR', 'GBP', now)).resolves.toBeNull();
  });

  it('selects the entry with the later effectiveAt for one pair', async () => {
    const provider = new StaticRateProvider([
      {
        base: 'EUR',
        quote: 'USD',
        rate: '1.0000000000',
        effectiveAt: new Date('2025-01-01T00:00:00.000Z'),
        source: 'old',
      },
      {
        base: 'EUR',
        quote: 'USD',
        rate: '1.0850000000',
        effectiveAt: new Date('2025-06-01T00:00:00.000Z'),
        source: 'new',
      },
    ]);

    const rate = await provider.rateFor('EUR', 'USD', now);

    expect(rate?.rate).toBe('1.0850000000');
    expect(rate?.source).toBe('new');
  });

  it('does not select an entry effective after asOf', async () => {
    const provider = new StaticRateProvider([
      {
        base: 'EUR',
        quote: 'USD',
        rate: '1.0850000000',
        effectiveAt: new Date('2026-01-02T00:00:00.000Z'),
        source: 'future',
      },
    ]);

    await expect(provider.rateFor('EUR', 'USD', now)).resolves.toBeNull();
  });
});
