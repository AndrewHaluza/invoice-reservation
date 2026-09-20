import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ReconciliationCheckService } from './reconciliation-check.service';

const RECONCILIATION_INTERVAL_NAME = 'reconciliation-check';

@Injectable()
export class ReconciliationCheckJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconciliationCheckJob.name);

  constructor(
    private readonly service: ReconciliationCheckService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const seconds = this.config.getOrThrow<number>(
      'RECONCILIATION_INTERVAL_SECONDS',
    );
    const intervalId = setInterval(() => {
      void this.service.check().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`reconciliation check failed: ${message}`);
      });
    }, seconds * 1000);

    this.schedulerRegistry.addInterval(
      RECONCILIATION_INTERVAL_NAME,
      intervalId,
    );
  }

  onModuleDestroy(): void {
    try {
      this.schedulerRegistry.deleteInterval(RECONCILIATION_INTERVAL_NAME);
    } catch {
      // No interval registered under this name; nothing to clear.
    }
  }
}
