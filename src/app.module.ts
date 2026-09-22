import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LoggerModule } from 'nestjs-pino';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { CapacityModule } from './capacity/capacity.module';
import { entities } from './capacity/infrastructure/entities';
import { ConfigurationModule } from './config/configuration.module';
import { buildPinoHttpOptions } from './config/logger.config';
import { HealthModule, MetricsModule } from './observability';
import { CorrelationMiddleware } from './shared/correlation';
import { TreasuryModule } from './treasury/treasury.module';

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
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: buildPinoHttpOptions(config.getOrThrow<string>('LOG_LEVEL')),
      }),
    }),
    AuthModule,
    CapacityModule,
    TreasuryModule,
    MetricsModule,
    HealthModule,
    ScheduleModule.forRoot(),
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('{*splat}');
  }
}
