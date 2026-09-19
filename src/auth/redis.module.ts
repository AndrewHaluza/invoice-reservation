import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRedisClient, REDIS_CLIENT } from './redis.provider';

// The Redis client must be visible both to AuthModule (which owns its shutdown)
// and to the ThrottlerModule dynamic module, whose factory dependencies resolve
// in the dynamic module's own scope and cannot see AuthModule's providers.
// A global module is the only way to make one client injectable in both.
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createRedisClient(
          config.getOrThrow<string>('REDIS_URL'),
          new Logger('RedisClient'),
        ),
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
