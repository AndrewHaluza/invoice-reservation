import type { INestApplication } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { buildOpenApiDocument } from './openapi-document.factory';

export interface ApiDocsOptions {
  readonly enabled: boolean;
  readonly port: number;
  readonly version: string;
}

export const DOCS_PATH = 'docs';
export const DOCS_JSON_PATH = 'docs/openapi.json';
export const DOCS_YAML_PATH = 'docs/openapi.yaml';

export function mountApiDocs(app: INestApplication, options: ApiDocsOptions): boolean {
  if (!options.enabled) {
    return false;
  }
  const document = buildOpenApiDocument(app, options.port, options.version);
  SwaggerModule.setup(DOCS_PATH, app, document, {
    jsonDocumentUrl: DOCS_JSON_PATH,
    yamlDocumentUrl: DOCS_YAML_PATH,
    customSiteTitle: 'Program Capacity & Invoice Reservation API',
    swaggerOptions: { persistAuthorization: true },
  });
  return true;
}
