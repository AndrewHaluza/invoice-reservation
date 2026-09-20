import type { IncomingMessage } from 'node:http';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module';
import { CapacityModule } from './capacity/capacity.module';
import { entities } from './capacity/infrastructure/entities';
import { ConfigurationModule } from './config/configuration.module';
import { HealthModule, MetricsModule } from './observability';
import {
  CORRELATION_HEADER,
  CorrelationMiddleware,
  resolveCorrelationId,
} from './shared/correlation';
import { TreasuryModule } from './treasury/treasury.module';

type CorrelationRequest = IncomingMessage & { correlationId?: string };

@Module({
  imports: [
    ConfigurationModule,
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.getOrThrow<string>('DATABASE_URL'),
        entities,
        synchronize: false,
        logging: false,
      }),
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        // Runs whether it is reached before or after CorrelationMiddleware: it
        // reuses an id already on the request, otherwise resolves one from the
        // header (or a fresh UUID) and stashes it for the middleware to reuse.
        genReqId: (req) => {
          const request = req as CorrelationRequest;
          const correlationId =
            request.correlationId ??
            resolveCorrelationId(request.headers[CORRELATION_HEADER]);
          request.correlationId = correlationId;
          return correlationId;
        },
        customProps: (req) => ({
          correlationId: (req as CorrelationRequest).correlationId,
        }),
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers["x-api-key"]',
          ],
          censor: '[redacted]',
        },
        formatters: {
          level: (label) => ({ level: label }),
        },
        // No transport / prettyPrint: production logs are JSON.
      },
    }),
    AuthModule,
    CapacityModule,
    TreasuryModule,
    MetricsModule,
    HealthModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('{*splat}');
  }
}
