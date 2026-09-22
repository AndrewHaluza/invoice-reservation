import { ConfigService } from '@nestjs/config';
import { KafkaDlqPublisher, DlqRecord } from '../../src/treasury/dlq/dlq.publisher';

const mockProducer = {
  connect: jest.fn<Promise<void>, []>(),
  send: jest.fn<Promise<void>, [unknown]>(),
  disconnect: jest.fn<Promise<void>, []>(),
};

jest.mock('kafkajs', () => ({
  Kafka: jest.fn().mockImplementation(() => ({
    producer: () => mockProducer,
  })),
  CompressionCodecs: {},
  CompressionTypes: { Snappy: 2 },
  logLevel: { NOTHING: 0, ERROR: 1, WARN: 2, INFO: 4, DEBUG: 5 },
}));

function configFrom(values: Record<string, unknown>): ConfigService {
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => values[key],
  } as unknown as ConfigService;
}

const credentials = {
  KAFKA_BROKERS: 'broker:9093',
  KAFKA_SASL_USERNAME: 'capacity',
  KAFKA_SASL_PASSWORD: 'secret',
  NODE_ENV: 'development',
};

const record = (overrides: Partial<DlqRecord> = {}): DlqRecord => ({
  reason: 'SCHEMA_INVALID',
  correlationId: 'corr-1',
  originalTopic: 'treasury.capacity.events',
  originalPartition: 2,
  originalOffset: '17',
  key: null,
  value: Buffer.from('{}'),
  ...overrides,
});

describe('KafkaDlqPublisher', () => {
  beforeEach(() => {
    mockProducer.connect.mockReset().mockResolvedValue(undefined);
    mockProducer.send.mockReset().mockResolvedValue(undefined);
    mockProducer.disconnect.mockReset().mockResolvedValue(undefined);
  });

  it('connects once and republishes the original bytes with quarantine headers', async () => {
    const publisher = new KafkaDlqPublisher(
      configFrom({ ...credentials, KAFKA_DLQ_TOPIC: 'treasury.capacity.dlq' }),
    );

    await publisher.publish(record());
    await publisher.publish(record({ reason: 'UNKNOWN_PROGRAM' }));

    expect(mockProducer.connect).toHaveBeenCalledTimes(1);
    expect(mockProducer.send).toHaveBeenCalledTimes(2);
    expect(mockProducer.send).toHaveBeenLastCalledWith({
      topic: 'treasury.capacity.dlq',
      messages: [
        {
          key: null,
          value: Buffer.from('{}'),
          headers: {
            reason: 'UNKNOWN_PROGRAM',
            correlationId: 'corr-1',
            originalTopic: 'treasury.capacity.events',
            originalPartition: '2',
            originalOffset: '17',
          },
        },
      ],
    });
  });

  it('falls back to the default DLQ topic and an empty correlation id', async () => {
    const publisher = new KafkaDlqPublisher(configFrom(credentials));

    await publisher.publish(record({ correlationId: null }));

    const [{ topic, messages }] = mockProducer.send.mock.calls[0] as [
      { topic: string; messages: { headers: Record<string, string> }[] },
    ];
    expect(topic).toBe('treasury.capacity.dlq');
    expect(messages[0]?.headers.correlationId).toBe('');
  });

  it('retries the connect on the next publish after a failure', async () => {
    const publisher = new KafkaDlqPublisher(configFrom(credentials));
    mockProducer.connect
      .mockRejectedValueOnce(new Error('broker down'))
      .mockResolvedValue(undefined);

    await expect(publisher.publish(record())).rejects.toThrow('broker down');
    await expect(publisher.publish(record())).resolves.toBeUndefined();

    expect(mockProducer.connect).toHaveBeenCalledTimes(2);
  });

  it('disconnects the producer on module destroy, and is a no-op before any publish', async () => {
    const publisher = new KafkaDlqPublisher(configFrom(credentials));
    await publisher.onModuleDestroy();
    expect(mockProducer.disconnect).not.toHaveBeenCalled();

    await publisher.publish(record());
    await publisher.onModuleDestroy();

    expect(mockProducer.disconnect).toHaveBeenCalledTimes(1);
  });
});
