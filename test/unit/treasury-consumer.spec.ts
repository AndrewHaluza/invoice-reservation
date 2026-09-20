import { ConfigService } from '@nestjs/config';
import {
  TreasuryConsumer,
  MessageCommitter,
} from '../../src/treasury/consumer/treasury.consumer';
import {
  CapacityEventHandler,
  InboundMessage,
} from '../../src/treasury/handlers/capacity-event.handler';
import { DlqPublisher, DlqRecord } from '../../src/treasury/dlq/dlq.publisher';
import { RetryPolicy } from '../../src/treasury/retry/failure-classifier';
import {
  getConsumerStatus,
  resetConsumerStatus,
} from '../../src/shared/health/consumer-health';

type CrashListener = (event: { payload: unknown }) => void;

interface KafkaMockConsumer {
  connect: jest.Mock;
  subscribe: jest.Mock;
  run: jest.Mock;
  commitOffsets: jest.Mock;
  disconnect: jest.Mock;
  on: jest.Mock;
  events: {
    CRASH: string;
    DISCONNECT: string;
    GROUP_JOIN: string;
    HEARTBEAT: string;
    REQUEST_TIMEOUT: string;
  };
  __emit: (name: string, payload: unknown) => void;
  __listeners: Record<string, CrashListener[]>;
}

jest.mock('kafkajs', () => {
  const listeners: Record<string, CrashListener[]> = {};
  const emit = (name: string, payload: unknown): void => {
    for (const listener of listeners[name] ?? []) {
      listener({ payload });
    }
  };
  const consumer = {
    connect: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn().mockResolvedValue(undefined),
    run: jest.fn().mockResolvedValue(undefined),
    commitOffsets: jest.fn().mockResolvedValue(undefined),
    on: jest.fn((name: string, listener: CrashListener) => {
      (listeners[name] ??= []).push(listener);
    }),
    disconnect: jest.fn().mockResolvedValue(undefined),
    events: {
      CRASH: 'consumer.crash',
      DISCONNECT: 'consumer.disconnect',
      GROUP_JOIN: 'consumer.group_join',
      HEARTBEAT: 'consumer.heartbeat',
      REQUEST_TIMEOUT: 'consumer.request_timeout',
    },
    __emit: emit,
    __listeners: listeners,
  };
  return {
    Kafka: jest.fn(function () {
      return { consumer: () => consumer };
    }),
    PartitionAssigners: { roundRobin: () => ({}) },
    CompressionCodecs: {},
    CompressionTypes: { Snappy: 2 },
    __consumer: consumer,
  };
});

const kafkajsMock = jest.requireMock('kafkajs') as {
  Kafka: jest.Mock;
  __consumer: KafkaMockConsumer;
};

const RETRY: RetryPolicy = { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 };

const DEV_CONFIG = {
  NODE_ENV: 'development',
  KAFKA_BROKERS: 'broker:9093',
  KAFKA_SASL_USERNAME: 'capacity',
  KAFKA_SASL_PASSWORD: 'secret',
  KAFKA_CONSUMER_GROUP_ID: 'capacity-treasury-consumer',
  KAFKA_CAPACITY_EVENTS_TOPIC: 'treasury.capacity.events',
  KAFKA_DLQ_TOPIC: 'treasury.capacity.dlq',
} as const;

function config(values: Record<string, unknown>): ConfigService {
  return {
    get: (key: string, fallback?: unknown) => values[key] ?? fallback,
    getOrThrow: (key: string) => {
      if (!(key in values)) {
        throw new Error(`missing ${key}`);
      }
      return values[key];
    },
  } as unknown as ConfigService;
}

class RecordingDlq implements DlqPublisher {
  readonly records: DlqRecord[] = [];
  async publish(record: DlqRecord): Promise<void> {
    this.records.push(record);
  }
}

function fixedHandler(outcome: unknown): CapacityEventHandler {
  return { handle: async () => outcome } as unknown as CapacityEventHandler;
}

function committer(): MessageCommitter & { committed: string[] } {
  const committed: string[] = [];
  return {
    committed,
    commitOffset: async (m: InboundMessage) => {
      committed.push(m.offset);
    },
  };
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

const tick = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('TreasuryConsumer (Kafka wiring)', () => {
  beforeEach(() => {
    kafkajsMock.Kafka.mockClear();
    kafkajsMock.__consumer.connect.mockClear().mockResolvedValue(undefined);
    kafkajsMock.__consumer.subscribe.mockClear().mockResolvedValue(undefined);
    kafkajsMock.__consumer.commitOffsets
      .mockClear()
      .mockResolvedValue(undefined);
    kafkajsMock.__consumer.disconnect.mockClear().mockResolvedValue(undefined);
    kafkajsMock.__consumer.on.mockClear();
    kafkajsMock.__consumer.run.mockClear().mockResolvedValue(undefined);
    for (const key of Object.keys(kafkajsMock.__consumer.__listeners)) {
      delete kafkajsMock.__consumer.__listeners[key];
    }
    resetConsumerStatus();
  });

  it('does not start the broker connection under NODE_ENV=test', async () => {
    const consumer = new TreasuryConsumer(
      fixedHandler({ kind: 'applied' }),
      new RecordingDlq(),
      RETRY,
      config({ NODE_ENV: 'test' }),
    );

    await consumer.onModuleInit();
    await flush();

    expect(kafkajsMock.Kafka).not.toHaveBeenCalled();
    await consumer.onModuleDestroy();
    expect(kafkajsMock.__consumer.disconnect).not.toHaveBeenCalled();
  });

  it('connects, subscribes, runs with autoCommit disabled, and commits offset+1', async () => {
    const consumer = new TreasuryConsumer(
      fixedHandler({ kind: 'applied' }),
      new RecordingDlq(),
      RETRY,
      config(DEV_CONFIG),
    );

    await consumer.onModuleInit();
    await flush();

    const kafkaConsumer = kafkajsMock.__consumer;
    expect(kafkaConsumer.connect).toHaveBeenCalledTimes(1);
    expect(kafkaConsumer.subscribe).toHaveBeenCalledWith({
      topic: 'treasury.capacity.events',
      fromBeginning: false,
    });
    expect(kafkaConsumer.on).toHaveBeenCalledWith(
      'consumer.crash',
      expect.any(Function),
    );
    expect(getConsumerStatus()).toBe('up');

    const runArgs = kafkaConsumer.run.mock.calls[0]?.[0] as {
      autoCommit: boolean;
      eachMessage: (input: unknown) => Promise<void>;
    };
    expect(runArgs.autoCommit).toBe(false);

    await runArgs.eachMessage({
      topic: 'treasury.capacity.events',
      partition: 0,
      message: {
        offset: '4',
        key: null,
        value: Buffer.from('{}'),
        headers: { correlationId: ['first', 'second'] },
      },
      heartbeat: () => undefined,
      pause: () => undefined,
    });

    expect(kafkaConsumer.commitOffsets).toHaveBeenCalledWith([
      { topic: 'treasury.capacity.events', partition: 0, offset: '5' },
    ]);

    await consumer.onModuleDestroy();
    expect(getConsumerStatus()).toBe('down');
  });

  it('rebuilds the consumer after a non-retriable crash and republishes readiness up', async () => {
    const consumer = new TreasuryConsumer(
      fixedHandler({ kind: 'applied' }),
      new RecordingDlq(),
      RETRY,
      config(DEV_CONFIG),
    );

    await consumer.onModuleInit();
    await flush();
    expect(kafkajsMock.Kafka).toHaveBeenCalledTimes(1);

    kafkajsMock.__consumer.__emit('consumer.crash', {
      error: new Error('KafkaJSNotImplemented: Snappy compression not implemented'),
      groupId: 'capacity-treasury-consumer',
      restart: false,
    });
    expect(getConsumerStatus()).toBe('down');
    await tick(30);

    expect(kafkajsMock.Kafka).toHaveBeenCalledTimes(2);
    expect(kafkajsMock.__consumer.connect).toHaveBeenCalledTimes(2);
    expect(getConsumerStatus()).toBe('up');

    await consumer.onModuleDestroy();
    expect(getConsumerStatus()).toBe('down');
  });

  it('leaves a retriable crash to KafkaJS and does not rebuild', async () => {
    const consumer = new TreasuryConsumer(
      fixedHandler({ kind: 'applied' }),
      new RecordingDlq(),
      RETRY,
      config(DEV_CONFIG),
    );

    await consumer.onModuleInit();
    await flush();

    kafkajsMock.__consumer.__emit('consumer.crash', {
      error: new Error('temporary'),
      groupId: 'capacity-treasury-consumer',
      restart: true,
    });
    await tick(30);

    expect(kafkajsMock.Kafka).toHaveBeenCalledTimes(1);
    // KafkaJS restarts this one internally; readiness must still show it is
    // down until the group re-joins.
    expect(getConsumerStatus()).toBe('down');

    kafkajsMock.__consumer.__emit('consumer.group_join', {
      groupId: 'capacity-treasury-consumer',
    });
    expect(getConsumerStatus()).toBe('up');

    await consumer.onModuleDestroy();
  });

  it('drops readiness when a request stalls and restores it on the next heartbeat', async () => {
    const consumer = new TreasuryConsumer(
      fixedHandler({ kind: 'applied' }),
      new RecordingDlq(),
      RETRY,
      config(DEV_CONFIG),
    );

    await consumer.onModuleInit();
    await flush();
    expect(getConsumerStatus()).toBe('up');

    // A paused broker stalls the heartbeat past the KafkaJS request timeout,
    // which surfaces as REQUEST_TIMEOUT rather than a crash (KafkaJS retries
    // internally). Readiness must reflect that the consumer cannot ingest.
    kafkajsMock.__consumer.__emit('consumer.request_timeout', {
      duration: 30000,
    });
    expect(getConsumerStatus()).toBe('down');

    // Once the broker responds again the next heartbeat proves liveness.
    kafkajsMock.__consumer.__emit('consumer.heartbeat', {
      groupId: 'capacity-treasury-consumer',
    });
    expect(getConsumerStatus()).toBe('up');

    await consumer.onModuleDestroy();
  });
});

describe('TreasuryConsumer.processMessage correlation ids', () => {
  beforeEach(() => {
    resetConsumerStatus();
  });

  it('passes a string correlation id through and quarantines the message', async () => {
    const dlq = new RecordingDlq();
    const consumer = new TreasuryConsumer(
      fixedHandler({ kind: 'quarantined', reason: 'SCHEMA_INVALID' }),
      dlq,
      RETRY,
      config({ NODE_ENV: 'test' }),
    );
    const c = committer();

    await consumer.processMessage(
      {
        topic: 'treasury.capacity.events',
        partition: 0,
        offset: '1',
        key: null,
        value: Buffer.from('{}'),
        headers: { correlationId: 'corr-1' },
      },
      c,
    );

    expect(dlq.records[0]?.correlationId).toBe('corr-1');
    expect(c.committed).toEqual(['1']);
  });

  it('decodes a buffer correlation id and treats a missing one as null', async () => {
    const dlq = new RecordingDlq();
    const consumer = new TreasuryConsumer(
      fixedHandler({ kind: 'quarantined', reason: 'UNKNOWN_PROGRAM' }),
      dlq,
      RETRY,
      config({ NODE_ENV: 'test' }),
    );

    await consumer.processMessage(
      {
        topic: 't',
        partition: 0,
        offset: '1',
        key: null,
        value: null,
        headers: { correlationId: Buffer.from('from-buffer') },
      },
      committer(),
    );
    await consumer.processMessage(
      { topic: 't', partition: 0, offset: '2', key: null, value: null, headers: {} },
      committer(),
    );

    expect(dlq.records[0]?.correlationId).toBe('from-buffer');
    expect(dlq.records[1]?.correlationId).toBeNull();
  });
});
