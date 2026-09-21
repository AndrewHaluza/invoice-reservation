import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { writeFileSync } from 'node:fs';
import { AppModule } from '../src/app.module';
import { buildOpenApiDocument } from '../src/docs';

// Exports the generated OpenAPI 3.1 document as JSON. Pass a path as the first
// argument to write a file; with no argument it goes to stdout.
//
// Requires a reachable database: `AppModule` connects to Postgres at init via
// TypeORM, so `DATABASE_URL` (and the rest of the validated environment) must be
// set to a live instance before this runs. The document is built purely from
// controller metadata and reads no data.
async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  try {
    const document = buildOpenApiDocument(
      app,
      Number(process.env.PORT ?? 3000),
      process.env.npm_package_version ?? '0.0.0',
    );
    const json = `${JSON.stringify(document, null, 2)}\n`;
    const target = process.argv[2];
    if (target === undefined) {
      process.stdout.write(json);
    } else {
      writeFileSync(target, json);
    }
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`openapi export failed: ${message}\n`);
    process.exitCode = 1;
  });
}
