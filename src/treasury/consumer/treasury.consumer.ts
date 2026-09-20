import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Kafka,
  PartitionAssigners,
  type Consumer,
  type EachMessagePayload,
  type PartitionAssigner,
} from 'kafkajs';
import { scheduler } from 'node:timers/promises';
import { setConsumerStatus } from '../../shared/health/consumer-health';
import {
  DLQ_PUBLISHER,
  type DlqPublisher,
  type DlqRecord,
} from '../dlq/dlq.publisher';
import {
  CapacityEventHandler,
  HandleOutcome,
  InboundMessage,
} from '../handlers/capacity-event.handler';
import {
  RetryExhaustedError,
  RetryPolicy,
  isTransientFailure,
  withRetry,
} from '../retry/failure-classifier';
import { buildKafkaConfig } from '../kafka.config';

export interface MessageCommitter {
  commitOffset(message: InboundMessage): Promise<void>;
}

export const TREASURY_RETRY_POLICY = 'TREASURY_RETRY_POLICY';

type InboundHeaders = Record<
  string,
  Buffer | string | ReadonlyArray<Buffer | string> | undefined
>;

// kafkajs 2.2.4 ships only the round-robin assigner; `cooperativeSticky` is
// absent from both its runtime exports and its typings. Read it defensively so
// this compiles against the pinned version and automatically uses cooperative
// stickiness if the dependency is later upgraded to a build that ships it.
const COOPERATIVE_STICKY: PartitionAssigner | undefined = (
  PartitionAssigners as typeof PartitionAssigners & {
    readonly cooperativeSticky?: PartitionAssigner;
  }
).cooperativeSticky;

function toInboundHeaders(
  headers: InboundHeaders,
): Record<string, string | Buffer | undefined> {
  const normalized: Record<string, string | Buffer | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key] = Array.isArray(value) ? value[0] : value;
  }
  return normalized;
}

function correlationIdOf(headers: InboundHeaders): string | null {
  const raw = headers['correlationId'];
  if (typeof raw === 'string') {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString('utf8');
  }
  return null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

@Injectable()
export class TreasuryConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TreasuryConsumer.name);
  private consumer: Consumer | null = null;
  private stopping = false;
  private rebuildScheduled = false;

  constructor(
    private readonly handler: CapacityEventHandler,
    @Inject(DLQ_PUBLISHER) private readonly dlq: DlqPublisher,
    @Inject(TREASURY_RETRY_POLICY) private readonly retryPolicy: RetryPolicy,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.config.get<string>('NODE_ENV') === 'test') {
      return;
    }

    // Started in the background so a broker outage cannot stop the HTTP server
    // from booting; start() owns reconnection from here on.
    void this.start().catch((error: unknown) => {
      this.logger.error(
        `capacity event consumer failed to start: ${describeError(error)}`,
      );
    });
  }

  async processMessage(
    message: InboundMessage,
    commit: MessageCommitter,
  ): Promise<void> {
    let outcome: HandleOutcome;
    try {
      outcome = await withRetry(
        () => this.handler.handle(message),
        this.retryPolicy,
        (error, attempt, delayMs) => {
          this.logger.warn(
            `capacity event handler failed (attempt ${attempt}); retrying in ${delayMs}ms: ${describeError(error)}`,
          );
        },
      );
    } catch (error) {
      // FR-035: a recognised transient failure (connection loss, pool
      // exhaustion, lock timeout, serialization failure) is never a reason to
      // quarantine. The in-process retry budget is exhausted, but the message
      // may still apply, so reject without publishing to the DLQ and without
      // committing the offset — KafkaJS then retries the batch and the position
      // is not advanced on a failure that was not the message's fault. Only a
      // permanent failure, or an unrecognised one that outlived the bound, is
      // quarantined.
      if (
        error instanceof RetryExhaustedError &&
        isTransientFailure(error.lastError)
      ) {
        this.logger.error(
          `capacity event handler still failing transiently after ${this.retryPolicy.maxAttempts} attempt(s); leaving the offset uncommitted so the message is retried: ${describeError(error.lastError)}`,
        );
        throw error;
      }

      this.logger.error(
        `capacity event handler failed permanently; quarantining: ${describeError(error)}`,
      );
      await this.quarantine(message, 'HANDLER_FAILURE');
      await commit.commitOffset(message);
      return;
    }

    if (outcome.kind === 'quarantined') {
      await this.quarantine(message, outcome.reason);
    }

    await commit.commitOffset(message);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    const consumer = this.consumer;
    if (consumer !== null) {
      await this.safeDisconnect(consumer);
    }
    setConsumerStatus('down');
  }

  /**
   * KafkaJS stops a consumer permanently when a non-retriable error crashes it
   * — a single undecodable batch (a missing codec, a malformed record) would
   * otherwise halt all ingestion until redeploy. `run()` resolves as soon as the
   * runner has started, so the crash is only observable through the `consumer.crash`
   * instrumentation event: KafkaJS restarts the consumer itself for retriable
   * errors (`restart: true`), and this loop rebuilds it for the rest. The
   * connected/disconnected state is published so `/health/ready` reflects the
   * outage instead of reporting the consumer up forever.
   */
  private async start(): Promise<void> {
    if (this.stopping) {
      return;
    }

    const consumer = this.createConsumer();
    this.consumer = consumer;
    // Group-membership and network liveness drive readiness (R10): a crash, a
    // disconnect, or a request that stalls past the KafkaJS request timeout
    // means the consumer cannot ingest, and KafkaJS restarts retriable failures
    // internally without any callback of ours, so the status must not stay 'up'
    // while the broker is unreachable. A successful join or heartbeat is the
    // signal that ingestion is live again. Heartbeats are sent every
    // heartbeatInterval while the consumer is running, so HEARTBEAT keeps the
    // status fresh; during a broker pause the heartbeat stalls and times out.
    consumer.on(consumer.events.CRASH, (event) => {
      this.logger.error(
        `capacity event consumer crashed (groupId ${event.payload.groupId}): ${describeError(event.payload.error)}`,
      );
      setConsumerStatus('down');
      if (!event.payload.restart) {
        void this.rebuild();
      }
    });
    consumer.on(consumer.events.DISCONNECT, () => {
      setConsumerStatus('down');
    });
    consumer.on(consumer.events.REQUEST_TIMEOUT, () => {
      setConsumerStatus('down');
    });
    consumer.on(consumer.events.GROUP_JOIN, () => {
      setConsumerStatus('up');
    });
    consumer.on(consumer.events.HEARTBEAT, () => {
      setConsumerStatus('up');
    });

    try {
      await consumer.connect();
      await consumer.subscribe({
        topic: this.eventsTopic(),
        fromBeginning: false,
      });
      setConsumerStatus('up');
      // `run()` resolves once the runner is started; the consumer keeps working
      // in the background from here until it is stopped or crashes.
      await consumer.run({
        autoCommit: false,
        eachMessage: (payload) => this.handleEachMessage(consumer, payload),
      });
    } catch (error) {
      this.logger.error(
        `capacity event consumer failed; restarting in ${this.restartDelayMs}ms: ${describeError(error)}`,
      );
      await this.rebuild();
    }
  }

  private async rebuild(): Promise<void> {
    if (this.stopping || this.rebuildScheduled) {
      return;
    }

    this.rebuildScheduled = true;
    setConsumerStatus('down');
    const consumer = this.consumer;
    this.consumer = null;
    if (consumer !== null) {
      await this.safeDisconnect(consumer);
    }

    await scheduler.wait(this.restartDelayMs);
    this.rebuildScheduled = false;

    if (this.stopping) {
      return;
    }
    await this.start();
  }

  private createConsumer(): Consumer {
    return new Kafka(buildKafkaConfig(this.config)).consumer({
      groupId: this.config.getOrThrow<string>('KAFKA_CONSUMER_GROUP_ID'),
      sessionTimeout: 30000,
      heartbeatInterval: 3000,
      partitionAssigners: [COOPERATIVE_STICKY ?? PartitionAssigners.roundRobin],
    });
  }

  private async handleEachMessage(
    consumer: Consumer,
    { topic, partition, message }: EachMessagePayload,
  ): Promise<void> {
    const inbound: InboundMessage = {
      topic,
      partition,
      offset: message.offset,
      key: message.key,
      value: message.value,
      headers: toInboundHeaders(message.headers ?? {}),
    };
    const committer: MessageCommitter = {
      commitOffset: async (m: InboundMessage) => {
        await consumer.commitOffsets([
          {
            topic: m.topic,
            partition: m.partition,
            offset: (BigInt(m.offset) + 1n).toString(),
          },
        ]);
      },
    };

    await this.processMessage(inbound, committer);
  }

  private async safeDisconnect(consumer: Consumer): Promise<void> {
    try {
      await consumer.disconnect();
    } catch (error) {
      this.logger.warn(
        `capacity event consumer disconnect failed: ${describeError(error)}`,
      );
    }
  }

  private eventsTopic(): string {
    return (
      this.config.get<string>('KAFKA_CAPACITY_EVENTS_TOPIC') ??
      'treasury.capacity.events'
    );
  }

  private get restartDelayMs(): number {
    return Math.max(this.retryPolicy.baseDelayMs, 1);
  }

  private async quarantine(
    message: InboundMessage,
    reason: string,
  ): Promise<void> {
    const record: DlqRecord = {
      reason,
      correlationId: correlationIdOf(message.headers),
      originalTopic: message.topic,
      originalPartition: message.partition,
      originalOffset: message.offset,
      key: message.key,
      value: message.value,
    };

    // A quarantined message deliberately gets no `processed_message` row: the
    // DLQ publish IS the durable quarantine record, and FR-036 requires a
    // replayed DLQ message to re-enter the ordinary validation/deduplication
    // path rather than being suppressed as already-processed.
    await withRetry(
      () => this.dlq.publish(record),
      this.retryPolicy,
      (error, attempt, delayMs) => {
        this.logger.warn(
          `DLQ publish failed (attempt ${attempt}); retrying in ${delayMs}ms: ${describeError(error)}`,
        );
      },
    );
  }
}
