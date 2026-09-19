import {
  Controller,
  Get,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import {
  HealthCheckService,
  type HealthIndicatorResult,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { Public } from '../shared/public';

/**
 * The minimal `Health` schema from `contracts/http-api.yaml`. It deliberately
 * names no host, broker, connection string, driver message or version.
 */
export interface HealthResponse {
  status: 'ok' | 'degraded';
  checks?: Record<string, 'up' | 'down'>;
}

/**
 * Phase 4 registers the treasury Kafka consumer here. Until a consumer exists
 * there is no consumer that can be *disconnected*, so readiness must not fail on
 * its account. A lagging consumer never fails readiness at all (FR-007c, R10):
 * the service still serves reads and reservations correctly.
 */
@Injectable()
export class ConsumerHealthIndicator {
  isHealthy(key: string): HealthIndicatorResult {
    return { [key]: { status: 'up' } };
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
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: TypeOrmHealthIndicator,
    private readonly consumer: ConsumerHealthIndicator,
  ) {}

  @Get('live')
  @Public()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @Public()
  async ready(): Promise<HealthResponse> {
    try {
      const result = await this.health.check([
        () => this.consumer.isHealthy('consumer'),
        () => this.database.pingCheck('database', { timeout: 1000 }),
      ]);
      return { status: 'ok', checks: toChecks(result.details) };
    } catch {
      // Terminus throws a ServiceUnavailableException whose body echoes the raw
      // indicator details. Replace it with the minimal schema so no driver
      // message, hostname, port or connection string can reach the client.
      throw new ServiceUnavailableException({
        status: 'degraded',
        checks: { database: 'down', consumer: 'up' },
      });
    }
  }
}
