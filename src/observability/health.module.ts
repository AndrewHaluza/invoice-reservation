import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import {
  ConsumerHealthIndicator,
  HealthController,
} from './health.controller';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [ConsumerHealthIndicator],
})
export class HealthModule {}
