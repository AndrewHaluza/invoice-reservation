import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FxRate, FxRateProvider } from '../capacity/domain/ports/fx-rate.provider';
import { scaleRate } from '../shared/money';

interface FxRateRow {
  rate: string | null;
  effective_at: Date;
  source: string;
}

const CACHE_TTL_MS = 60_000;

@Injectable()
export class CachedRateProvider implements FxRateProvider {
  private readonly cache = new Map<
    string,
    { value: FxRate; expiresAt: number }
  >();

  constructor(private readonly dataSource: DataSource) {}

  async rateFor(
    base: string,
    quote: string,
    asOf: Date,
  ): Promise<FxRate | null> {
    const key = `${base}:${quote}`;
    const now = Date.now();
    const cached = this.cache.get(key);

    if (cached !== undefined && cached.expiresAt > now) {
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

    this.cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
    return value;
  }

  clearCache(): void {
    this.cache.clear();
  }
}
