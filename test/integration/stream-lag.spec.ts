import 'reflect-metadata';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Kafka, type Producer } from 'kafkajs';
import { randomUUID } from 'node:crypto';
import { scheduler } from 'node:timers/promises';
import { StreamLagRegistry } from '../../src/shared/stream-lag';
import { StreamLagProbe } from '../../src/treasury/consumer/stream-lag.probe';
import {
  RedpandaFixture,
  kafkaEnvFor,
  startRedpanda,
} from '../support/redpanda-container';
import { capacityEventMessage, snapshotMessage } from '../support/treasury';

jest.setTimeout(300_000);

const GROUP_ID = 'stream-lag-spec-lag-probe';

describe('stream lag probe', () => {
  let redpanda: RedpandaFixture;
  let moduleRef: TestingModule;
  let registry: StreamLagRegistry;
  let producer: Producer;

  const waitFor = async (
    probe: () => number | null,
    deadlineMs = 60_000,
  ): Promise<number | null> => {
    const deadline = Date.now() + deadlineMs;
    let value = probe();
    while (value === null && Date.now() < deadline) {
      await scheduler.wait(200);
      value = probe();
    }
    return value;
  };

  // `fromBeginning: false` makes the probe start at the latest offset when the
  // group first joins, so a message published during the join can fall before
  // that starting offset and never be seen. Republishing a warm-up until the
  // probe observes one proves it is consuming and makes the cases below
  // deterministic.
  const waitUntilConsuming = async (): Promise<void> => {
    const programId = randomUUID();
    const value = capacityEventMessage({ programId }).value;
    const deadline = Date.now() + 120_000;
    for (;;) {
      await producer.send({
        topic: redpanda.eventsTopic,
        messages: [{ key: programId, value }],
      });
      const observed = await waitFor(
        () => registry.newestObservedFor(programId),
        2_000,
      );
      if (observed !== null) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error('stream lag probe did not consume a published message');
      }
    }
  };

  beforeAll(async () => {
    redpanda = await startRedpanda();

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              ...kafkaEnvFor(redpanda),
              KAFKA_CONSUMER_GROUP_ID: 'stream-lag-spec',
            }),
          ],
        }),
      ],
      providers: [StreamLagRegistry, StreamLagProbe],
    }).compile();

    registry = moduleRef.get(StreamLagRegistry);
    await moduleRef.init();

    producer = new Kafka({ brokers: redpanda.brokers, ssl: false }).producer();
    await producer.connect();

    await waitUntilConsuming();
  });

  afterAll(async () => {
    await producer?.disconnect();
    await moduleRef?.close();
    await redpanda?.stop();
  });

  it('records the effective time of a message published after the probe starts', async () => {
    const programId = randomUUID();
    const effectiveAt = '2026-03-01T00:00:00.000Z';

    await producer.send({
      topic: redpanda.eventsTopic,
      messages: [
        {
          key: programId,
          value: capacityEventMessage({ programId, effectiveAt }).value,
        },
      ],
    });

    const observed = await waitFor(() =>
      registry.newestObservedFor(programId),
    );

    expect(observed).toBe(Date.parse(effectiveAt));
  });

  it('reports null for a program with no message', () => {
    expect(registry.newestObservedFor(randomUUID())).toBeNull();
  });

  it('keeps the newest effective time across the events and snapshots topics', async () => {
    const programId = randomUUID();
    const base = Date.parse('2026-04-01T00:00:00.000Z');
    const eventAt = new Date(base).toISOString();
    const snapshotAt = new Date(base + 60_000).toISOString();

    await producer.send({
      topic: redpanda.eventsTopic,
      messages: [
        {
          key: programId,
          value: capacityEventMessage({ programId, effectiveAt: eventAt }).value,
        },
      ],
    });
    await producer.send({
      topic: redpanda.snapshotsTopic,
      messages: [
        {
          key: programId,
          value: snapshotMessage({ programId, effectiveAt: snapshotAt }).value,
        },
      ],
    });

    const observed = await waitFor(() =>
      registry.newestObservedFor(programId) === base + 60_000
        ? base + 60_000
        : null,
    );

    expect(observed).toBe(base + 60_000);
  });

  it('does not commit offsets', async () => {
    const admin = new Kafka({ brokers: redpanda.brokers, ssl: false }).admin();
    await admin.connect();
    try {
      const offsets = await admin.fetchOffsets({
        groupId: GROUP_ID,
        topics: [redpanda.eventsTopic],
      });

      const partitions = offsets.flatMap((topicOffsets) => topicOffsets.partitions);
      expect(partitions.length).toBeGreaterThan(0);
      for (const partition of partitions) {
        expect(partition.offset).toBe('-1');
      }
    } finally {
      await admin.disconnect();
    }
  });
});
