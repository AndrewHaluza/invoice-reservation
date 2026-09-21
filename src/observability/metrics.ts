import {
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics,
  register,
  type Metric,
  type Registry,
} from 'prom-client';

/**
 * The process-wide default registry. Collectors are registered here so any layer
 * can increment them without walking this module's construction path again.
 */
export const metricsRegistry: Registry = register;

function getOrCreate<T extends string, M extends Metric<T>>(
  name: string,
  create: () => M,
): M {
  const existing = metricsRegistry.getSingleMetric<T>(name);
  if (existing !== undefined) {
    return existing as M;
  }
  return create();
}

export let reservationOutcomesTotal: Counter<'outcome' | 'reason'>;
export let ledgerAppendDurationSeconds: Histogram;
export let consumerLagMessages: Gauge<'program_id'>;
export let overLimitPrograms: Gauge;
export let dlqDepth: Gauge;
export let investigationRequiredPrograms: Gauge;
export let positionUnverifiedPrograms: Gauge;

/**
 * Registers every collector. Idempotent: prom-client's default registry is
 * process-global, so a second pass (a re-import in one Jest worker) reuses what
 * is already there instead of throwing "already been registered".
 */
export function registerMetrics(): void {
  reservationOutcomesTotal = getOrCreate(
    'reservation_outcomes_total',
    () =>
      new Counter<'outcome' | 'reason'>({
        name: 'reservation_outcomes_total',
        help: 'Reservation attempts by terminal outcome and, when refused, the reason.',
        labelNames: ['outcome', 'reason'],
        registers: [metricsRegistry],
      }),
  );

  ledgerAppendDurationSeconds = getOrCreate(
    'ledger_append_duration_seconds',
    () =>
      new Histogram({
        name: 'ledger_append_duration_seconds',
        help: 'Duration of a ledger append, in seconds.',
        buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
        registers: [metricsRegistry],
      }),
  );

  consumerLagMessages = getOrCreate(
    'consumer_lag_messages',
    () =>
      new Gauge<'program_id'>({
        name: 'consumer_lag_messages',
        help: 'Messages the treasury consumer is behind per program.',
        labelNames: ['program_id'],
        registers: [metricsRegistry],
      }),
  );

  overLimitPrograms = getOrCreate(
    'over_limit_programs',
    () =>
      new Gauge({
        name: 'over_limit_programs',
        help: 'Programs whose local reservations exceed their credit limit.',
        registers: [metricsRegistry],
      }),
  );

  dlqDepth = getOrCreate(
    'dlq_depth',
    () =>
      new Gauge({
        name: 'dlq_depth',
        help: 'Messages currently parked in the dead-letter topic.',
        registers: [metricsRegistry],
      }),
  );

  investigationRequiredPrograms = getOrCreate(
    'investigation_required_programs',
    () =>
      new Gauge({
        name: 'investigation_required_programs',
        help: 'Programs the consumer has flagged as requiring investigation.',
        registers: [metricsRegistry],
      }),
  );

  positionUnverifiedPrograms = getOrCreate(
    'position_unverified_programs',
    () =>
      new Gauge({
        name: 'position_unverified_programs',
        help: 'Programs held unverified pending a fresh treasury snapshot.',
        registers: [metricsRegistry],
      }),
  );

  // collectDefaultMetrics registers process-level collectors directly; calling it
  // twice on the same registry throws. Reuse when a pass already happened.
  if (metricsRegistry.getSingleMetric('process_cpu_seconds_total') === undefined) {
    collectDefaultMetrics({ register: metricsRegistry });
  }
}

/** Resets all registered metric values. Tests only. */
export function resetMetrics(): void {
  metricsRegistry.resetMetrics();
}

registerMetrics();
