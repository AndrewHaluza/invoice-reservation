import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CapacityModule } from '../capacity/capacity.module';
import { DLQ_PUBLISHER, KafkaDlqPublisher } from './dlq/dlq.publisher';
import { CapacityEventHandler } from './handlers/capacity-event.handler';
import { RetryPolicy } from './retry/failure-classifier';
import {
  TREASURY_RETRY_POLICY,
  TreasuryConsumer,
} from './consumer/treasury.consumer';

@Module({
  imports: [CapacityModule],
  providers: [
    CapacityEventHandler,
    KafkaDlqPublisher,
    { provide: DLQ_PUBLISHER, useExisting: KafkaDlqPublisher },
    {
      provide: TREASURY_RETRY_POLICY,
      useFactory: (config: ConfigService): RetryPolicy => ({
        maxAttempts: config.get<number>('KAFKA_RETRY_MAX_ATTEMPTS', 5),
        baseDelayMs: config.get<number>('KAFKA_RETRY_BASE_DELAY_MS', 200),
        maxDelayMs: config.get<number>('KAFKA_RETRY_MAX_DELAY_MS', 10000),
      }),
      inject: [ConfigService],
    },
    TreasuryConsumer,
  ],
})
export class TreasuryModule {}
