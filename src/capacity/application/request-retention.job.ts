import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DataSource } from 'typeorm';

const RETENTION_INTERVAL_NAME = 'request-retention';
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

@Injectable()
export class RequestRetentionJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RequestRetentionJob.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly config: ConfigService,
  ) {}

  async sweep(): Promise<number> {
    const days = this.config.getOrThrow<number>('REQUEST_RETENTION_DAYS');
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [, affected] = await this.dataSource.query<[unknown[], number]>(
      `UPDATE request_record
          SET state = 'EXPIRED', outcome = NULL
        WHERE state = 'COMPLETE'
          AND recorded_at < $1`,
      [cutoff],
    );

    const stuckRows = await this.dataSource.query<{ stuck: number }[]>(
      `SELECT count(*)::int AS stuck
         FROM request_record
        WHERE state = 'PENDING'
          AND recorded_at < $1`,
      [cutoff],
    );
    const stuck = stuckRows[0]?.stuck ?? 0;

    if (stuck > 0) {
      this.logger.warn(
        `${stuck} request_record row(s) have been PENDING since before the retention cutoff; a writer crashed mid-request and the key cannot be replayed or reused`,
      );
    }

    return affected;
  }

  onModuleInit(): void {
    const intervalId = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`request retention sweep failed: ${message}`);
      });
    }, RETENTION_SWEEP_INTERVAL_MS);

    this.schedulerRegistry.addInterval(RETENTION_INTERVAL_NAME, intervalId);
  }

  onModuleDestroy(): void {
    try {
      this.schedulerRegistry.deleteInterval(RETENTION_INTERVAL_NAME);
    } catch {
      // No interval registered under this name; nothing to clear.
    }
  }
}
