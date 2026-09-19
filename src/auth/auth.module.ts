import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import Redis from 'ioredis';
import { JwtAuthGuard } from './jwt-auth.guard';
import { OrgThrottlerGuard } from './org-throttler.guard';
import { ProgramScopeGuard } from './program-scope.guard';
import { ScopeGuard } from './scope.guard';
import { createThrottlerOptions } from './throttler.config';
import { REDIS_CLIENT } from './redis.provider';
import { RedisModule } from './redis.module';

@Module({
  imports: [
    RedisModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { algorithm: 'HS256' },
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService, REDIS_CLIENT],
      useFactory: (config: ConfigService, client: Redis) =>
        createThrottlerOptions(config, client),
    }),
  ],
  providers: [
    // Order is the contract, not a preference. Ownership (ProgramScopeGuard) MUST resolve
    // before scope (ScopeGuard). Reversed, a scope refusal on another organisation's program
    // answers 403 where it must answer 404, and the guard chain becomes an existence oracle
    // that confirms which program ids are real. See research R7 and FR-017.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: OrgThrottlerGuard },
    { provide: APP_GUARD, useClass: ProgramScopeGuard },
    { provide: APP_GUARD, useClass: ScopeGuard },
  ],
  exports: [JwtModule, RedisModule],
})
export class AuthModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      // The client was already closed.
    }
  }
}
