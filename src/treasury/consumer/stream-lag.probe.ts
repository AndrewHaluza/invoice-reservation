import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, type Consumer, type EachMessagePayload } from 'kafkajs';
import { StreamLagRegistry } from '../../shared/stream-lag';
import { buildKafkaConfig } from '../kafka.config';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface StreamHeadFields {
  readonly programId?: unknown;
  readonly effectiveAt?: unknown;
}

@Injectable()
export class StreamLagProbe implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StreamLagProbe.name);
  private consumer: Consumer | null = null;
  private stopping = false;

  constructor(
    private readonly config: ConfigService,
    private readonly registry: StreamLagRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.config.get<string>('KAFKA_LAG_PROBE_ENABLED') === 'false') {
      return;
    }

    // Started in the background so a broker outage cannot stop the HTTP server
    // from booting; a null lag beats an API that will not start.
    void this.start().catch((error: unknown) => {
      this.logger.error(
        `stream lag probe failed to start: ${describeError(error)}`,
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    const consumer = this.consumer;
    if (consumer !== null) {
      try {
        await consumer.disconnect();
      } catch (error) {
        this.logger.warn(
          `stream lag probe disconnect failed: ${describeError(error)}`,
        );
      }
    }
  }

  private async start(): Promise<void> {
    if (this.stopping) {
      return;
    }

    const consumer = new Kafka(buildKafkaConfig(this.config)).consumer({
      groupId: `${this.config.getOrThrow<string>('KAFKA_CONSUMER_GROUP_ID')}-lag-probe`,
    });
    this.consumer = consumer;

    await consumer.connect();
    await consumer.subscribe({
      topics: [this.eventsTopic(), this.snapshotsTopic()],
      fromBeginning: false,
    });
    await consumer.run({
      autoCommit: false,
      eachMessage: (payload) => this.handleEachMessage(payload),
    });
  }

  private async handleEachMessage({
    message,
  }: EachMessagePayload): Promise<void> {
    try {
      const raw = message.value?.toString('utf8');
      if (raw === undefined) {
        this.logger.warn('stream lag probe skipped a message with no value');
        return;
      }

      const parsed = JSON.parse(raw) as StreamHeadFields;
      const programId = parsed.programId;
      if (typeof programId !== 'string' || programId.length === 0) {
        this.logger.warn(
          'stream lag probe skipped a message without a programId',
        );
        return;
      }
      if (typeof parsed.effectiveAt !== 'string') {
        this.logger.warn(
          'stream lag probe skipped a message without an effectiveAt',
        );
        return;
      }

      const effectiveAtMs = Date.parse(parsed.effectiveAt);
      if (Number.isNaN(effectiveAtMs)) {
        this.logger.warn(
          `stream lag probe skipped an unparseable effectiveAt: ${parsed.effectiveAt}`,
        );
        return;
      }

      this.registry.observe(programId, effectiveAtMs);
    } catch (error) {
      this.logger.warn(
        `stream lag probe skipped an unreadable message: ${describeError(error)}`,
      );
    }
  }

  private eventsTopic(): string {
    return (
      this.config.get<string>('KAFKA_CAPACITY_EVENTS_TOPIC') ??
      'treasury.capacity.events'
    );
  }

  private snapshotsTopic(): string {
    return (
      this.config.get<string>('KAFKA_SNAPSHOTS_TOPIC') ??
      'treasury.capacity.snapshots'
    );
  }
}
