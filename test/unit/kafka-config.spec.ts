import { ConfigService } from '@nestjs/config';
import { buildKafkaConfig } from '../../src/treasury/kafka.config';

function configFrom(values: Record<string, unknown>): ConfigService {
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      if (!(key in values)) {
        throw new Error(`missing ${key}`);
      }
      return values[key];
    },
  } as unknown as ConfigService;
}

describe('buildKafkaConfig', () => {
  const base = {
    KAFKA_BROKERS: 'broker-a:9093, broker-b:9093 ,,',
    KAFKA_SASL_USERNAME: 'capacity',
    KAFKA_SASL_PASSWORD: 'secret',
  };

  it('splits, trims and de-blanks the broker list, and disables SSL outside production', () => {
    const config = buildKafkaConfig(
      configFrom({ ...base, NODE_ENV: 'development' }),
    );

    expect(config.brokers).toEqual(['broker-a:9093', 'broker-b:9093']);
    expect(config.ssl).toBe(false);
    expect(config.sasl).toEqual({
      mechanism: 'scram-sha-512',
      username: 'capacity',
      password: 'secret',
    });
    expect(config.clientId).toBe('capacity-service');
    expect(config.retry).toEqual({ retries: 5 });
  });

  it('enables SSL in production', () => {
    const config = buildKafkaConfig(
      configFrom({ ...base, NODE_ENV: 'production' }),
    );

    expect(config.ssl).toBe(true);
  });

  it('propagates a missing required variable', () => {
    expect(() => buildKafkaConfig(configFrom({ NODE_ENV: 'development' }))).toThrow(
      /KAFKA_BROKERS/,
    );
  });
});
