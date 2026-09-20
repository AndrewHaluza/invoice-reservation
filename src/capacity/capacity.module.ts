import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { FX_RATE_PROVIDER } from './domain/ports/fx-rate.provider';
import { CachedRateProvider } from '../fx/cached-rate.provider';
import { AuditController } from './api/audit.controller';
import { CapacityController } from './api/capacity.controller';
import { CapacityErrorFilter } from './api/error.filter';
import { ApplyTreasuryEventService } from './application/apply-treasury-event.service';
import { ApplySnapshotService } from './application/apply-snapshot.service';
import { AuditReadService } from './application/audit-read.service';
import { AvailabilityService } from './application/availability.service';
import { CancelService } from './application/cancel.service';
import { IdempotencyService } from './application/idempotency.service';
import { ReleaseService } from './application/release.service';
import { ReconciliationCheckJob } from './application/reconciliation-check.job';
import { ReconciliationCheckService } from './application/reconciliation-check.service';
import { RecoveryDetectionService } from './application/recovery-detection.service';
import { RequestRetentionJob } from './application/request-retention.job';
import { ReserveService } from './application/reserve.service';
import { LedgerRepository } from './infrastructure/repositories/ledger.repository';
import { ProgramRepository } from './infrastructure/repositories/program.repository';
import { ProgramStreamPositionRepository } from './infrastructure/repositories/program-stream-position.repository';
import { UnitOfWork } from './infrastructure/unit-of-work';
import { StreamLagRegistry } from '../shared/stream-lag';

@Module({
  controllers: [CapacityController, AuditController],
  providers: [
    UnitOfWork,
    ProgramRepository,
    ProgramStreamPositionRepository,
    LedgerRepository,
    IdempotencyService,
    ReserveService,
    ReleaseService,
    CancelService,
    AvailabilityService,
    AuditReadService,
    ApplyTreasuryEventService,
    ApplySnapshotService,
    ReconciliationCheckService,
    ReconciliationCheckJob,
    RecoveryDetectionService,
    RequestRetentionJob,
    StreamLagRegistry,
    { provide: FX_RATE_PROVIDER, useClass: CachedRateProvider },
    { provide: APP_FILTER, useClass: CapacityErrorFilter },
  ],
  exports: [
    ApplyTreasuryEventService,
    ApplySnapshotService,
    ProgramStreamPositionRepository,
    StreamLagRegistry,
  ],
})
export class CapacityModule {}
