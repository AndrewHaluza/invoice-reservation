import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { JwtAuthGuard } from './jwt-auth.guard';
import { OrgThrottlerGuard } from './org-throttler.guard';
import { ProgramScopeGuard } from './program-scope.guard';
import { ScopeGuard } from './scope.guard';
import { createThrottlerOptions } from './throttler.config';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { algorithm: 'HS256' },
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => createThrottlerOptions(config),
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
  exports: [JwtModule],
})
export class AuthModule {}
