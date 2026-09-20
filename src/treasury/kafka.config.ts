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

  const saslDisabled = config.get<string>('KAFKA_SASL_DISABLED') === 'true';

  return {
    brokers,
    clientId: 'capacity-service',
    // Local compose brokers expose a PLAINTEXT+SASL listener; production requires SASL_SSL/mTLS per research R11.
    ssl: config.get<string>('NODE_ENV') === 'production',
    // The Redpanda testcontainer renders authentication_method: none and offers
    // no way to enable SASL, so tests set KAFKA_SASL_DISABLED=true. Never set in
    // compose or production, where the default 'false' keeps SCRAM mandatory.
    ...(saslDisabled
      ? {}
      : {
          sasl: {
            mechanism: 'scram-sha-512' as const,
            username: config.getOrThrow<string>('KAFKA_SASL_USERNAME'),
            password: config.getOrThrow<string>('KAFKA_SASL_PASSWORD'),
          },
        }),
    retry: {
      retries: 5,
    },
  };
}
