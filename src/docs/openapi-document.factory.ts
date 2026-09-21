import type { INestApplication, Type } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { buildDocumentConfig } from './openapi-metadata';

export const UNAUTHENTICATED_OPERATIONS: readonly string[] = [
  '/health/live',
  '/health/ready',
];

export function buildOpenApiDocument(
  app: INestApplication,
  port: number,
  version: string,
  extraModels: Type<unknown>[] = [],
): OpenAPIObject {
  const generated = SwaggerModule.createDocument(app, buildDocumentConfig(port, version), {
    autoTagControllers: false,
    extraModels,
  });
  return withUnauthenticatedHealthOperations(generated);
}

export function withUnauthenticatedHealthOperations(document: OpenAPIObject): OpenAPIObject {
  const newPaths = Object.fromEntries(
    Object.entries(document.paths).map(([path, pathItem]) => {
      const isPublic = UNAUTHENTICATED_OPERATIONS.includes(path);
      if (!isPublic || !pathItem.get) {
        return [path, pathItem];
      }
      return [path, { ...pathItem, get: { ...pathItem.get, security: [] } }];
    }),
  );
  return { ...document, paths: newPaths };
}
