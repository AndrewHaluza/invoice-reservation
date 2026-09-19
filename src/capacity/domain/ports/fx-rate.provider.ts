/** A rate resolved for a currency pair, with everything needed to denormalise it. */
export interface FxRate {
  /** The rate scaled by RATE_SCALE (10n ** 10n), ready for `convert`. */
  readonly scaledRate: bigint;
  /** The canonical decimal string as stored, e.g. '1.0850000000'. Written to the reservation row. */
  readonly rate: string;
  readonly effectiveAt: Date;
  readonly source: string;
}

export interface FxRateProvider {
  /** Newest rate with effective_at <= asOf, or null when the pair has none. */
  rateFor(base: string, quote: string, asOf: Date): Promise<FxRate | null>;
}

export const FX_RATE_PROVIDER = Symbol('FX_RATE_PROVIDER');
