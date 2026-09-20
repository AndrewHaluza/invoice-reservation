import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, Producer } from 'kafkajs';
import { buildKafkaConfig } from '../kafka.config';

export interface DlqRecord {
  readonly reason: string;
  readonly correlationId: string | null;
  readonly originalTopic: string;
  readonly originalPartition: number;
  readonly originalOffset: string;
  readonly key: Buffer | null;
  readonly value: Buffer | null;
}

export interface DlqPublisher {
  publish(record: DlqRecord): Promise<void>;
}

export const DLQ_PUBLISHER = 'DLQ_PUBLISHER';

@Injectable()
export class KafkaDlqPublisher implements DlqPublisher, OnModuleDestroy {
  private readonly logger = new Logger(KafkaDlqPublisher.name);
  private kafka: Kafka | null = null;
  private producer: Producer | null = null;
  private connectPromise: Promise<Producer> | null = null;

  constructor(private readonly config: ConfigService) {}

  async publish(record: DlqRecord): Promise<void> {
    const producer = await this.ensureProducer();

    await producer.send({
      topic: this.dlqTopic(),
      messages: [
        {
          key: record.key,
          value: record.value,
          headers: {
            reason: record.reason,
            correlationId: record.correlationId ?? '',
            originalTopic: record.originalTopic,
            originalPartition: String(record.originalPartition),
            originalOffset: record.originalOffset,
          },
        },
      ],
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.producer !== null) {
      await this.producer.disconnect();
      this.producer = null;
      this.connectPromise = null;
    }
  }

  private dlqTopic(): string {
    return (
      this.config.get<string>('KAFKA_DLQ_TOPIC') ?? 'treasury.capacity.dlq'
    );
  }

  private ensureProducer(): Promise<Producer> {
    if (this.connectPromise === null) {
      if (this.producer === null) {
        this.producer = this.kafkaClient().producer();
      }
      const producer = this.producer;

      this.connectPromise = producer
        .connect()
        .then(() => producer)
        .catch((error: unknown) => {
          this.connectPromise = null;
          this.logger.warn('DLQ producer connect failed; will retry on next publish');
          throw error;
        });
    }

    return this.connectPromise;
  }

  private kafkaClient(): Kafka {
    if (this.kafka === null) {
      this.kafka = new Kafka(buildKafkaConfig(this.config));
    }

    return this.kafka;
  }
}
