import { ConsumerHealthIndicator } from '../../src/observability/health.controller';
import {
  getConsumerStatus,
  resetConsumerStatus,
  setConsumerStatus,
} from '../../src/shared/health/consumer-health';

describe('consumer health state', () => {
  afterEach(() => {
    resetConsumerStatus();
  });

  it('defaults to up so readiness does not fail before a consumer runs', () => {
    expect(getConsumerStatus()).toBe('up');
  });

  it('reflects a published update and resets', () => {
    setConsumerStatus('down');
    expect(getConsumerStatus()).toBe('down');

    resetConsumerStatus();
    expect(getConsumerStatus()).toBe('up');
  });

  it('is surfaced by the readiness indicator', () => {
    const indicator = new ConsumerHealthIndicator();

    expect(indicator.isHealthy('consumer')).toEqual({
      consumer: { status: 'up' },
    });

    setConsumerStatus('down');
    expect(indicator.isHealthy('consumer')).toEqual({
      consumer: { status: 'down' },
    });
  });
});
