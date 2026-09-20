import { ConfigService } from '@nestjs/config';
import type { KafkaConfig } from 'kafkajs';
import { registerKafkaCodecs } from './kafka-codecs';

export function buildKafkaConfig(config: ConfigService): KafkaConfig {
  registerKafkaCodecs();

  const brokers = config
    .getOrThrow<string>('KAFKA_BROKERS')
    .split(',')
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);

  return {
    brokers,
    clientId: 'capacity-service',
    // Local compose brokers expose a PLAINTEXT+SASL listener; production requires SASL_SSL/mTLS per research R11.
    ssl: config.get<string>('NODE_ENV') === 'production',
    sasl: {
      mechanism: 'scram-sha-512',
      username: config.getOrThrow<string>('KAFKA_SASL_USERNAME'),
      password: config.getOrThrow<string>('KAFKA_SASL_PASSWORD'),
    },
    retry: {
      retries: 5,
    },
  };
}
