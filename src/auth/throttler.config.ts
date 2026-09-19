import { ConfigService } from '@nestjs/config';
import { ThrottlerModuleOptions } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import Redis from 'ioredis';

export function createThrottlerOptions(
  config: ConfigService,
  client: Redis,
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
    storage: new ThrottlerStorageRedisService(client),
  };
}
