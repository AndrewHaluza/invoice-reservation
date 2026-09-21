import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';
import { buildOpenApiDocument } from '../../src/docs';
import { AuditController } from '../../src/capacity/api/audit.controller';
import { CapacityController } from '../../src/capacity/api/capacity.controller';
import { AuditReadService } from '../../src/capacity/application/audit-read.service';
import { AvailabilityService } from '../../src/capacity/application/availability.service';
import { CancelService } from '../../src/capacity/application/cancel.service';
import { ReleaseService } from '../../src/capacity/application/release.service';
import { ReserveService } from '../../src/capacity/application/reserve.service';
import {
  ConsumerHealthIndicator,
  HealthController,
} from '../../src/observability/health.controller';

export interface OpenApiTestDocument {
  readonly app: INestApplication;
  readonly document: OpenAPIObject;
  close(): Promise<void>;
}

/**
 * Builds the real generated OpenAPI document — every controller, path, operation,
 * parameter and request body — without a database, Redis or Kafka. The controllers are
 * registered with inert stubs for their injected services, so `paths` is populated
 * exactly as it is in production while `app.init()` never opens a connection.
 *
 * This exists so the Docker-free documentation gate can assert over the operations a
 * caller actually sees. An empty module renders `paths = {}`, which makes any assertion
 * that walks operations vacuously true — the defect this helper removes.
 */
export async function buildOpenApiDocumentWithoutDatabase(): Promise<OpenApiTestDocument> {
  const moduleRef = await Test.createTestingModule({
    controllers: [CapacityController, AuditController, HealthController],
    providers: [
      { provide: ReserveService, useValue: {} },
      { provide: ReleaseService, useValue: {} },
      { provide: CancelService, useValue: {} },
      { provide: AvailabilityService, useValue: {} },
      { provide: AuditReadService, useValue: {} },
      { provide: HealthCheckService, useValue: {} },
      { provide: TypeOrmHealthIndicator, useValue: {} },
      ConsumerHealthIndicator,
    ],
  }).compile();

  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();

  try {
    const document = buildOpenApiDocument(app, 4010, '0.1.0');
    return { app, document, close: () => app.close() };
  } catch (error) {
    await app.close();
    throw error;
  }
}

/**
 * The path-and-method pairs the generated document must contain. Asserting this set in
 * each Docker-free documentation spec keeps the operations in `paths` from silently
 * disappearing, which would make every operation-walking assertion vacuous.
 */
export const EXPECTED_OPERATIONS: readonly string[] = [
  'post /v1/programs/{programId}/reservations',
  'get /v1/programs/{programId}/reservations',
  'post /v1/programs/{programId}/reservations/{invoiceId}/releases',
  'post /v1/programs/{programId}/reservations/{invoiceId}/cancellation',
  'get /v1/programs/{programId}/availability',
  'get /v1/programs/{programId}/reservations/{invoiceId}',
  'get /v1/programs/{programId}/ledger',
  'get /health/live',
  'get /health/ready',
];
