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
import { getConsumerStatus } from '../shared/health/consumer-health';

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
      // message, hostname, port or connection string can reach the client. The
      // individual states are re-derived so the body names what actually failed:
      // a disconnected consumer must be visible, not reported up.
      let database: 'up' | 'down' = 'up';
      try {
        await this.database.pingCheck('database', { timeout: 1000 });
      } catch {
        database = 'down';
      }
      throw new ServiceUnavailableException({
        status: 'degraded',
        checks: { consumer: getConsumerStatus(), database },
      });
    }
  }
}
