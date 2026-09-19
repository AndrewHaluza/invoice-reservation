import { Counter, Gauge, Histogram } from 'prom-client';
import {
  consumerLagMessages,
  dlqDepth,
  investigationRequiredPrograms,
  ledgerAppendDurationSeconds,
  metricsRegistry,
  overLimitPrograms,
  registerMetrics,
  reservationOutcomesTotal,
} from '../../src/observability/metrics';

const NAMES = [
  'reservation_outcomes_total',
  'ledger_append_duration_seconds',
  'consumer_lag_messages',
  'over_limit_programs',
  'dlq_depth',
  'investigation_required_programs',
];

describe('observability metrics', () => {
  it('registers all six named collectors', () => {
    for (const name of NAMES) {
      expect(metricsRegistry.getSingleMetric(name)).toBeDefined();
    }
  });

  it('uses the specified collector types', () => {
    expect(reservationOutcomesTotal).toBeInstanceOf(Counter);
    expect(ledgerAppendDurationSeconds).toBeInstanceOf(Histogram);
    expect(consumerLagMessages).toBeInstanceOf(Gauge);
    expect(overLimitPrograms).toBeInstanceOf(Gauge);
    expect(dlqDepth).toBeInstanceOf(Gauge);
    expect(investigationRequiredPrograms).toBeInstanceOf(Gauge);
  });

  it('carries both outcome and reason labels on reservation_outcomes_total', async () => {
    reservationOutcomesTotal.inc({ outcome: 'reserved', reason: 'none' });
    const data = await reservationOutcomesTotal.get();
    const labels = data.values[0]?.labels ?? {};

    expect(Object.keys(labels)).toEqual(
      expect.arrayContaining(['outcome', 'reason']),
    );
  });

  it('labels consumer_lag_messages by program_id', async () => {
    consumerLagMessages.set({ program_id: 'program-1' }, 0);
    const data = await consumerLagMessages.get();
    const labels = data.values[0]?.labels ?? {};

    expect(Object.keys(labels)).toEqual(['program_id']);
  });

  it('does not throw when the collectors are registered twice', () => {
    const before = metricsRegistry.getSingleMetric('reservation_outcomes_total');
    expect(() => {
      registerMetrics();
      registerMetrics();
    }).not.toThrow();
    expect(
      metricsRegistry.getSingleMetric('reservation_outcomes_total'),
    ).toBe(before);
  });

  it('can be imported a second time without throwing', async () => {
    jest.resetModules();
    await expect(import('../../src/observability/metrics')).resolves.toBeDefined();
  });
});
