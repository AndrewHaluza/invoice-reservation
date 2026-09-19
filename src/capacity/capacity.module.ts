import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { FX_RATE_PROVIDER } from './domain/ports/fx-rate.provider';
import { CachedRateProvider } from '../fx/cached-rate.provider';
import { AuditController } from './api/audit.controller';
import { CapacityController } from './api/capacity.controller';
import { CapacityErrorFilter } from './api/error.filter';
import { AuditReadService } from './application/audit-read.service';
import { AvailabilityService } from './application/availability.service';
import { IdempotencyService } from './application/idempotency.service';
import { ReleaseService } from './application/release.service';
import { ReserveService } from './application/reserve.service';
import { LedgerRepository } from './infrastructure/repositories/ledger.repository';
import { ProgramRepository } from './infrastructure/repositories/program.repository';
import { UnitOfWork } from './infrastructure/unit-of-work';

@Module({
  controllers: [CapacityController, AuditController],
  providers: [
    UnitOfWork,
    ProgramRepository,
    LedgerRepository,
    IdempotencyService,
    ReserveService,
    ReleaseService,
    AvailabilityService,
    AuditReadService,
    { provide: FX_RATE_PROVIDER, useClass: CachedRateProvider },
    { provide: APP_FILTER, useClass: CapacityErrorFilter },
  ],
})
export class CapacityModule {}
