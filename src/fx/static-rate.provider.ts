import { FxRate, FxRateProvider } from '../capacity/domain/ports/fx-rate.provider';
import { scaleRate } from '../shared/money';

export interface StaticRateEntry {
  readonly base: string;
  readonly quote: string;
  readonly rate: string;
  readonly effectiveAt: Date;
  readonly source: string;
}

export class StaticRateProvider implements FxRateProvider {
  constructor(private readonly rates: ReadonlyArray<StaticRateEntry>) {}

  async rateFor(
    base: string,
    quote: string,
    asOf: Date,
  ): Promise<FxRate | null> {
    let newest: StaticRateEntry | null = null;

    for (const entry of this.rates) {
      if (entry.base !== base || entry.quote !== quote) {
        continue;
      }
      if (entry.effectiveAt > asOf) {
        continue;
      }
      if (newest === null || entry.effectiveAt > newest.effectiveAt) {
        newest = entry;
      }
    }

    if (newest === null) {
      return null;
    }

    return {
      scaledRate: scaleRate(newest.rate),
      rate: newest.rate,
      effectiveAt: newest.effectiveAt,
      source: newest.source,
    };
  }
}
