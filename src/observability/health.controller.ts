import {
  Controller,
  Get,
  Injectable,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import {
  HealthCheckService,
  type HealthIndicatorResult,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import type { Response } from 'express';
import { Public } from '../shared/public';
import { getConsumerStatus } from '../shared/health/consumer-health';
import { HealthProbeResponse } from './health.response';

/**
 * The minimal `Health` schema from `contracts/http-api.yaml`. It deliberately
 * names no host, broker, connection string, driver message or version.
 */
export interface HealthResponse {
  status: 'ok' | 'degraded';
  checks?: Record<string, 'up' | 'down'>;
}

/**
 * Reports the treasury consumer's connectivity. The consumer publishes its own
 * state (up/down) into process-global health state; the probe reads it here so
 * the two modules stay independent.
 */
@Injectable()
export class ConsumerHealthIndicator {
  isHealthy(key: string): HealthIndicatorResult {
    return { [key]: { status: getConsumerStatus() } };
  }
}

function toChecks(details: HealthIndicatorResult): Record<string, 'up' | 'down'> {
  const checks: Record<string, 'up' | 'down'> = {};
  for (const [key, value] of Object.entries(details)) {
    checks[key] = value.status;
  }
  return checks;
}

// Probes are read-only traffic: they consume the read bucket and never the write bucket.
@SkipThrottle({ write: true })
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: TypeOrmHealthIndicator,
    private readonly consumer: ConsumerHealthIndicator,
  ) {}

  @Get('live')
  @Public()
  @ApiOperation({
    operationId: 'live',
    summary: 'Liveness probe. Reports that the process is running.',
  })
  @ApiResponse({ status: 200, description: 'The process is alive.', type: HealthProbeResponse })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @Public()
  @ApiOperation({
    operationId: 'ready',
    summary: 'Readiness probe. Reports whether dependencies are reachable.',
  })
  @ApiResponse({
    status: 200,
    description: 'Every dependency is reachable.',
    type: HealthProbeResponse,
  })
  @ApiResponse({
    status: 503,
    description: 'At least one dependency is unavailable. The body names which.',
    type: HealthProbeResponse,
  })
  async ready(
    @Res({ passthrough: true }) response: Response,
  ): Promise<HealthResponse> {
    try {
      const result = await this.health.check([
        () => this.consumer.isHealthy('consumer'),
        () => this.database.pingCheck('database', { timeout: 1000 }),
      ]);
      return { status: 'ok', checks: toChecks(result.details) };
    } catch {
      // Terminus throws a ServiceUnavailableException whose body echoes the raw
      // indicator details. Re-derive the individual states so the body names
      // what actually failed: a disconnected consumer must be visible, not
      // reported up. The status is set on the response directly rather than
      // re-thrown, because the application-wide error filter maps every 5xx
      // HttpException to a generic 500 — a readiness probe must answer 503 with
      // the minimal `Health` schema (the contract declares exactly 200/503).
      let database: 'up' | 'down' = 'up';
      try {
        await this.database.pingCheck('database', { timeout: 1000 });
      } catch {
        database = 'down';
      }
      response.status(503);
      return {
        status: 'degraded',
        checks: { consumer: getConsumerStatus(), database },
      };
    }
  }
}
