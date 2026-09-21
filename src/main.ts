import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { mountApiDocs } from './docs';
import { createValidationPipe } from './shared/validation/create-validation-pipe';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.useGlobalPipes(createValidationPipe());
  app.enableShutdownHooks();
  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3000);
  const docsEnabled = configService.get<string>('API_DOCS_ENABLED', 'false') === 'true';
  const mounted = mountApiDocs(app, {
    enabled: docsEnabled,
    port,
    version: process.env.npm_package_version ?? '0.0.0',
  });
  await app.listen(port);
  console.log(
    `Application is running on port ${port}. API documentation ${mounted ? `at http://localhost:${port}/docs` : 'disabled'}`,
  );
}

void bootstrap();
