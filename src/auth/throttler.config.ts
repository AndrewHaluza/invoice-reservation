import { ConfigService } from '@nestjs/config';
import { ThrottlerModuleOptions } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import Redis from 'ioredis';

export function createThrottlerOptions(
  config: ConfigService,
): ThrottlerModuleOptions {
  return {
    throttlers: [
      {
        name: 'read',
        ttl: 60_000,
        limit: config.getOrThrow<number>('RATE_LIMIT_READ_PER_MINUTE'),
      },
      {
        name: 'write',
        ttl: 60_000,
        limit: config.getOrThrow<number>('RATE_LIMIT_WRITE_PER_MINUTE'),
      },
    ],
    storage: new ThrottlerStorageRedisService(
      new Redis(config.getOrThrow<string>('REDIS_URL'), {
        maxRetriesPerRequest: 3,
      }),
    ),
  };
}
