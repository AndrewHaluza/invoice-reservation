import { DataSource } from 'typeorm';
import { StaticRateProvider } from '../../src/fx';
import { CachedRateProvider } from '../../src/fx/cached-rate.provider';

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

interface FxRateRow {
  rate: string | null;
  effective_at: Date;
  source: string;
}

function row(
  rate: string,
  effectiveAt: Date,
  source = 'test',
): FxRateRow {
  return { rate, effective_at: effectiveAt, source };
}

describe('CachedRateProvider', () => {
  const t0 = new Date('2026-01-01T00:00:00.000Z');
  const oldEffectiveAt = new Date('2025-01-01T00:00:00.000Z');
  const newEffectiveAt = new Date('2025-06-01T00:00:00.000Z');
  const backdatedAsOf = new Date('2025-03-01T00:00:00.000Z');

  let query: jest.Mock;
  let provider: CachedRateProvider;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(t0);
    query = jest.fn();
    provider = new CachedRateProvider({ query } as unknown as DataSource);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('answers for each asOf when a rate became effective between two lookups inside the TTL', async () => {
    query.mockResolvedValueOnce([row('1.0850000000', newEffectiveAt, 'new')]);
    query.mockResolvedValueOnce([row('1.0000000000', oldEffectiveAt, 'old')]);

    const recent = await provider.rateFor('EUR', 'USD', t0);
    const backdated = await provider.rateFor('EUR', 'USD', backdatedAsOf);

    expect(recent?.rate).toBe('1.0850000000');
    expect(backdated?.rate).toBe('1.0000000000');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('does not serve a newer cached rate to a backdated asOf inside the TTL', async () => {
    query.mockResolvedValueOnce([row('1.0850000000', newEffectiveAt, 'new')]);
    query.mockResolvedValueOnce([row('1.0000000000', oldEffectiveAt, 'old')]);

    await provider.rateFor('EUR', 'USD', t0);
    const backdated = await provider.rateFor('EUR', 'USD', backdatedAsOf);

    expect(backdated?.rate).toBe('1.0000000000');
  });

  it('serves a cached entry when asOf is not older than its effectiveAt', async () => {
    query.mockResolvedValue([row('1.0850000000', oldEffectiveAt, 'seed')]);

    const first = await provider.rateFor('EUR', 'USD', t0);
    const second = await provider.rateFor('EUR', 'USD', t0);

    expect(first?.rate).toBe('1.0850000000');
    expect(second?.rate).toBe('1.0850000000');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('does not let a historical lookup evict or overwrite the hot entry', async () => {
    query.mockResolvedValueOnce([row('1.0850000000', newEffectiveAt, 'new')]);
    query.mockResolvedValueOnce([row('1.0000000000', oldEffectiveAt, 'old')]);

    const hot = await provider.rateFor('EUR', 'USD', t0);
    const historical = await provider.rateFor('EUR', 'USD', backdatedAsOf);
    const hotAgain = await provider.rateFor('EUR', 'USD', t0);

    expect(hot?.rate).toBe('1.0850000000');
    expect(historical?.rate).toBe('1.0000000000');
    expect(hotAgain?.rate).toBe('1.0850000000');
    expect(query).toHaveBeenCalledTimes(2);
  });
});
