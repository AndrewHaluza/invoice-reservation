import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FxRate, FxRateProvider } from '../capacity/domain/ports/fx-rate.provider';
import { scaleRate } from '../shared/money';

interface FxRateRow {
  rate: string | null;
  effective_at: Date;
  source: string;
}

interface Entry {
  readonly value: FxRate;
  readonly expiresAt: number;
}

const CACHE_TTL_MS = 60_000;

@Injectable()
export class CachedRateProvider implements FxRateProvider {
  private readonly cache = new Map<string, Entry>();

  constructor(private readonly dataSource: DataSource) {}

  async rateFor(
    base: string,
    quote: string,
    asOf: Date,
  ): Promise<FxRate | null> {
    const key = `${base}:${quote}`;
    const now = Date.now();
    const cached = this.cache.get(key);

    // The entry answers for the `asOf` it is asked about, not the one that
    // populated it: it is served only while it is still effective at `asOf`.
    // A backdated `asOf` falls through to the parameterised query instead of
    // receiving a rate that had not taken effect yet.
    if (
      cached !== undefined &&
      cached.expiresAt > now &&
      asOf.getTime() >= cached.value.effectiveAt.getTime()
    ) {
      return cached.value;
    }

    const rows = await this.dataSource.query<FxRateRow[]>(
      `SELECT rate, effective_at, source
         FROM fx_rate
        WHERE base_currency = $1 AND quote_currency = $2 AND effective_at <= $3
        ORDER BY effective_at DESC
        LIMIT 1`,
      [base, quote, asOf],
    );

    const row = rows[0];
    if (row === undefined || row.rate === null) {
      return null;
    }

    const value: FxRate = {
      scaledRate: scaleRate(row.rate),
      rate: row.rate,
      effectiveAt: row.effective_at,
      source: row.source,
    };

    // A historical lookup must never displace the hot entry: cache the result
    // only when it is at least as new as what the entry already holds.
    if (
      cached === undefined ||
      value.effectiveAt.getTime() >= cached.value.effectiveAt.getTime()
    ) {
      this.cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
    }

    return value;
  }

  clearCache(): void {
    this.cache.clear();
  }
}
