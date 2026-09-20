import { RedpandaContainer } from '@testcontainers/redpanda';
import { Kafka } from 'kafkajs';

export interface RedpandaFixture {
  brokers: string[];
  eventsTopic: string;
  snapshotsTopic: string;
  dlqTopic: string;
  stop: () => Promise<void>;
}

const EVENTS_TOPIC = 'treasury.capacity.events';
const SNAPSHOTS_TOPIC = 'treasury.capacity.snapshots';
const DLQ_TOPIC = 'treasury.capacity.dlq';

export async function startRedpanda(): Promise<RedpandaFixture> {
  const container = await new RedpandaContainer(
    'docker.redpanda.com/redpandadata/redpanda:v24.2.18',
  )
    .withStartupTimeout(120_000)
    .start();

  const brokers = [container.getBootstrapServers()];

  const admin = new Kafka({ brokers, ssl: false }).admin();
  await admin.connect();
  try {
    await admin.createTopics({
      topics: [
        { topic: EVENTS_TOPIC, numPartitions: 3, replicationFactor: 1 },
        { topic: SNAPSHOTS_TOPIC, numPartitions: 3, replicationFactor: 1 },
        { topic: DLQ_TOPIC, numPartitions: 3, replicationFactor: 1 },
      ],
      waitForLeaders: true,
    });
  } finally {
    await admin.disconnect();
  }

  return {
    brokers,
    eventsTopic: EVENTS_TOPIC,
    snapshotsTopic: SNAPSHOTS_TOPIC,
    dlqTopic: DLQ_TOPIC,
    stop: async () => {
      await container.stop();
    },
  };
}

export function kafkaEnvFor(redpanda: RedpandaFixture): Record<string, string> {
  return {
    KAFKA_BROKERS: redpanda.brokers.join(','),
    KAFKA_CAPACITY_EVENTS_TOPIC: redpanda.eventsTopic,
    KAFKA_SNAPSHOTS_TOPIC: redpanda.snapshotsTopic,
    KAFKA_DLQ_TOPIC: redpanda.dlqTopic,
    KAFKA_SASL_DISABLED: 'true',
  };
}
