import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { INestApplication, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  DiscoveryModule,
  DiscoveryService,
  MetadataScanner,
  Reflector,
} from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { sign } from 'jsonwebtoken';
import request from 'supertest';
import { DataSource } from 'typeorm';
import {
  resetConsumerStatus,
  setConsumerStatus,
} from '../../src/shared/health/consumer-health';
import { IS_PUBLIC_KEY } from '../../src/shared/public';
import { REQUIRED_SCOPE_KEY } from '../../src/shared/scope';
import { createValidationPipe } from '../../src/shared/validation/create-validation-pipe';
import { openapiValidator } from '../support/openapi';
import { PostgresFixture, startPostgres } from '../support/postgres-container';
import { RedisFixture, startRedis } from '../support/redis-container';
import {
  insertLocalReservation,
  insertOrganisation,
  insertProgram,
} from '../support/treasury';

jest.setTimeout(180_000);

const JWT_SECRET = 'integration-test-secret-0123456789abcdef';

const PUBLIC_ROUTE_LABELS = ['GET /health/live', 'GET /health/ready'];

interface RouteDefinition {
  readonly method: RequestMethod;
  readonly path: string;
  readonly isPublic: boolean;
  readonly requiredScope: string | undefined;
}

interface ValidRequest {
  readonly path: string;
  readonly body: object | undefined;
  readonly idempotencyKey: string | undefined;
}

interface SendOptions {
  readonly token: string | undefined;
  readonly body: object | undefined;
  readonly idempotencyKey: string | undefined;
  readonly correlationId: string | undefined;
}

const NO_OPTIONS: SendOptions = {
  token: undefined,
  body: undefined,
  idempotencyKey: undefined,
  correlationId: undefined,
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

function normalisePath(...segments: (string | undefined)[]): string {
  const parts = segments
    .filter((segment): segment is string => typeof segment === 'string')
    .map((segment) => segment.replace(/^\/+/, '').replace(/\/+$/, ''))
    .filter((segment) => segment.length > 0);
  return `/${parts.join('/')}`;
}

function concretePath(
  path: string,
  programId: string,
  invoiceId: string,
): string {
  return path.replace(':programId', programId).replace(':invoiceId', invoiceId);
}

function methodLabel(method: RequestMethod): string {
  return RequestMethod[method] ?? `REQ_${method}`;
}

function routeLabel(route: RouteDefinition): string {
  return `${methodLabel(route.method)} ${route.path}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Runs assertions with the route under test prefixed to any failure. */
function check(context: string, assertions: () => void): void {
  try {
    assertions();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${context}: ${message}`);
  }
}

function assertNoInternalKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      assertNoInternalKeys(entry);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    expect(['stack', 'sql', 'query']).not.toContain(key);
    assertNoInternalKeys(child);
  }
}

/**
 * Enumerates every route Nest actually registered, straight from the router
 * metadata. A route added to the app is therefore covered automatically; there
 * is no hand-maintained list to drift.
 */
function enumerateRoutes(
  discovery: DiscoveryService,
  scanner: MetadataScanner,
  reflector: Reflector,
): RouteDefinition[] {
  const routes: RouteDefinition[] = [];

  for (const wrapper of discovery.getControllers()) {
    const instance = wrapper.instance as object | null;
    const metatype = wrapper.metatype;
    if (instance === null || metatype === null || metatype === undefined) {
      continue;
    }

    const controllerPath = Reflect.getMetadata(
      PATH_METADATA,
      metatype,
    ) as string | undefined;
    const prototype = Object.getPrototypeOf(instance) as Record<
      string,
      unknown
    >;

    for (const methodName of scanner.getAllMethodNames(prototype)) {
      const handler = prototype[methodName];
      if (typeof handler !== 'function') {
        continue;
      }

      const method = Reflect.getMetadata(
        METHOD_METADATA,
        handler,
      ) as RequestMethod | undefined;
      if (method === undefined) {
        continue;
      }

      const methodPath = Reflect.getMetadata(
        PATH_METADATA,
        handler,
      ) as string | undefined;

      routes.push({
        method,
        path: normalisePath(controllerPath, methodPath),
        isPublic:
          reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
            handler,
            metatype,
          ]) === true,
        requiredScope: reflector.getAllAndOverride<string>(REQUIRED_SCOPE_KEY, [
          handler,
          metatype,
        ]),
      });
    }
  }

  return routes;
}

function validRequestFor(
  route: RouteDefinition,
  programId: string,
  uniqueInvoiceId: string,
): ValidRequest {
  if (route.method === RequestMethod.POST) {
    if (route.path.endsWith('/reservations')) {
      return {
        path: concretePath(route.path, programId, 'INV-1'),
        body: {
          invoiceId: uniqueInvoiceId,
          amount: { amountMinor: '100', currency: 'USD' },
        },
        idempotencyKey: `authz-reserve-${randomUUID()}`,
      };
    }
    if (route.path.endsWith('/releases')) {
      return {
        path: concretePath(route.path, programId, 'INV-REL'),
        body: { amount: { amountMinor: '10', currency: 'USD' } },
        idempotencyKey: 'authz-release-key',
      };
    }
    if (route.path.endsWith('/cancellation')) {
      return {
        path: concretePath(route.path, programId, 'INV-CAN'),
        body: { reason: 'CANCELLED' },
        idempotencyKey: 'authz-cancel-key',
      };
    }
    throw new Error(`No valid request is defined for POST route ${route.path}`);
  }

  return {
    path: concretePath(route.path, programId, 'INV-1'),
    body: undefined,
    idempotencyKey: undefined,
  };
}

describe('auth enumeration contract', () => {
  let postgres: PostgresFixture;
  let redis: RedisFixture;
  let owner: DataSource;
  let app: INestApplication;

  let organisationA: string;
  let organisationB: string;
  let programA: string;
  let programB: string;

  let tokenNone: string;
  let tokenRead: string;
  let tokenWrite: string;
  let tokenAudit: string;
  let tokenAll: string;

  let routes: RouteDefinition[] = [];
  let nonPublicRoutes: RouteDefinition[] = [];
  let scopedRoutes: RouteDefinition[] = [];

  const collectedBodies: unknown[] = [];
  const collectedStatuses: number[] = [];

  const savedEnv = new Map<string, string | undefined>();

  const setEnv = (key: string, value: string): void => {
    savedEnv.set(key, process.env[key]);
    process.env[key] = value;
  };

  const hs256 = (claims: Record<string, unknown>): string =>
    sign(claims, JWT_SECRET, { algorithm: 'HS256' });

  const tokenFor = (organisationId: string, scope?: string): string =>
    hs256({
      org: organisationId,
      ...(scope === undefined ? {} : { scope }),
      exp: nowSeconds() + 3600,
    });

  const send = (
    method: RequestMethod,
    path: string,
    options: SendOptions,
  ) => {
    if (method !== RequestMethod.GET && method !== RequestMethod.POST) {
      throw new Error(`Unsupported RequestMethod ${methodLabel(method)}`);
    }
    const agent = request(app.getHttpServer());
    let pending =
      method === RequestMethod.GET ? agent.get(path) : agent.post(path);
    if (options.token !== undefined) {
      pending = pending.set('Authorization', `Bearer ${options.token}`);
    }
    if (options.correlationId !== undefined) {
      pending = pending.set('x-correlation-id', options.correlationId);
    }
    if (options.idempotencyKey !== undefined) {
      pending = pending.set('Idempotency-Key', options.idempotencyKey);
    }
    if (options.body !== undefined) {
      pending = pending.send(options.body);
    }
    return pending;
  };

  beforeAll(async () => {
    postgres = await startPostgres();
    redis = await startRedis();

    owner = new DataSource({
      ...(await import('../../src/config/data-source')).dataSourceOptions,
      url: postgres.ownerUrl,
      entities: [],
    });
    await owner.initialize();
    await owner.runMigrations();

    organisationA = await insertOrganisation(owner, 'auth-enum-org-a');
    organisationB = await insertOrganisation(owner, 'auth-enum-org-b');
    programA = await insertProgram(owner, organisationA, {
      currency: 'USD',
      creditLimitMinor: 1_000_000,
      localReservedMinor: 3000,
    });
    programB = await insertProgram(owner, organisationB, {
      currency: 'USD',
      creditLimitMinor: 1_000_000,
    });
    for (const invoiceId of ['INV-1', 'INV-REL', 'INV-CAN']) {
      await insertLocalReservation(owner, programA, {
        invoiceId,
        treasuryReference: null,
        status: 'ACTIVE',
      });
    }

    tokenNone = tokenFor(organisationA);
    tokenRead = tokenFor(organisationA, 'capacity:read');
    tokenWrite = tokenFor(organisationA, 'capacity:write');
    tokenAudit = tokenFor(organisationA, 'capacity:audit');
    tokenAll = tokenFor(
      organisationA,
      'capacity:read capacity:write capacity:audit',
    );

    setEnv('DATABASE_URL', postgres.appUrl);
    setEnv('MIGRATION_DATABASE_URL', postgres.ownerUrl);
    setEnv('REDIS_URL', redis.url);
    setEnv('KAFKA_BROKERS', 'localhost:9093');
    setEnv('KAFKA_LAG_PROBE_ENABLED', 'false');
    setEnv('KAFKA_SASL_USERNAME', 'capacity');
    setEnv('KAFKA_SASL_PASSWORD', 'capacity_local_dev');
    setEnv('JWT_SECRET', JWT_SECRET);

    const { AppModule } = await import('../../src/app.module');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, DiscoveryModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    await app.init();

    const discovery = app.get(DiscoveryService);
    const scanner = app.get(MetadataScanner);
    const reflector = app.get(Reflector);
    routes = enumerateRoutes(discovery, scanner, reflector);
    nonPublicRoutes = routes.filter((route) => !route.isPublic);
    scopedRoutes = routes.filter((route) => route.path.includes(':programId'));
  });

  afterAll(async () => {
    if (app !== undefined) {
      const storage = app.get(
        ThrottlerStorage,
      ) as ThrottlerStorageRedisService;
      await app.close();
      storage.redis.disconnect();
    }
    if (owner?.isInitialized) {
      await owner.destroy();
    }
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await redis?.stop();
    await postgres?.stop();
  });

  it('enumerates every route: only the two probes are public, every other route declares a scope', () => {
    expect(routes.length).toBeGreaterThanOrEqual(3);

    const publicLabels = routes
      .filter((route) => route.isPublic)
      .map((route) => routeLabel(route))
      .sort();
    expect(publicLabels).toEqual(PUBLIC_ROUTE_LABELS);

    // No route is silently outside the enumeration.
    expect(nonPublicRoutes).toHaveLength(
      routes.length - PUBLIC_ROUTE_LABELS.length,
    );

    for (const route of nonPublicRoutes) {
      check(
        `${routeLabel(route)} must declare a non-empty @RequiredScope`,
        () => {
          expect((route.requiredScope ?? '').length).toBeGreaterThan(0);
        },
      );
    }
  });

  it('answers 401 UNAUTHENTICATED without a token on every non-public route', async () => {
    for (const route of nonPublicRoutes) {
      const response = await send(
        route.method,
        concretePath(route.path, programA, 'INV-1'),
        NO_OPTIONS,
      );
      check(`${routeLabel(route)} unauthenticated`, () => {
        expect(response.status).toBe(401);
        expect(response.body.code).toBe('UNAUTHENTICATED');
      });
      collectedStatuses.push(response.status);
      collectedBodies.push(response.body);
    }
  });

  it('answers 403 INSUFFICIENT_SCOPE for a scope-less token on every non-public route', async () => {
    for (const route of nonPublicRoutes) {
      const response = await send(
        route.method,
        concretePath(route.path, programA, 'INV-1'),
        { ...NO_OPTIONS, token: tokenNone },
      );
      check(`${routeLabel(route)} no scope`, () => {
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('INSUFFICIENT_SCOPE');
      });
      collectedStatuses.push(response.status);
      collectedBodies.push(response.body);
    }
  });

  it('answers 403 INSUFFICIENT_SCOPE for a token that holds other scopes only', async () => {
    const tokenByScope: Record<string, string> = {
      'capacity:read': tokenRead,
      'capacity:write': tokenWrite,
      'capacity:audit': tokenAudit,
    };

    for (const route of nonPublicRoutes) {
      const required = route.requiredScope;
      if (required === undefined) {
        continue;
      }
      const lacking = Object.entries(tokenByScope).find(
        ([scope]) => scope !== required,
      );
      if (lacking === undefined) {
        throw new Error(`No wrong-scope token available for ${required}`);
      }

      const response = await send(
        route.method,
        concretePath(route.path, programA, 'INV-1'),
        { ...NO_OPTIONS, token: lacking[1] },
      );
      check(`${routeLabel(route)} wrong scope (holds ${lacking[0]})`, () => {
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('INSUFFICIENT_SCOPE');
      });
    }
  });

  it('serves every non-public route with a fully-scoped token (never 401/403/500)', async () => {
    const uniqueInvoiceId = `authz-enum-${randomUUID()}`;

    for (const route of nonPublicRoutes) {
      const valid = validRequestFor(route, programA, uniqueInvoiceId);
      const response = await send(route.method, valid.path, {
        token: tokenAll,
        body: valid.body,
        idempotencyKey: valid.idempotencyKey,
        correlationId: undefined,
      });
      check(`${routeLabel(route)} valid request`, () => {
        expect(response.status).not.toBe(401);
        expect(response.status).not.toBe(403);
        expect(response.status).not.toBe(500);
      });
      collectedStatuses.push(response.status);
      collectedBodies.push(response.body);
    }
  });

  it('serves /health/live and /health/ready through the real pipeline', async () => {
    const live = await request(app.getHttpServer()).get('/health/live');
    expect(live.status).toBe(200);
    expect(live.body).toEqual({ status: 'ok' });
    collectedStatuses.push(live.status);
    collectedBodies.push(live.body);

    const ready = await request(app.getHttpServer()).get('/health/ready');
    check('readiness must not be flattened to 500', () => {
      expect(ready.status).not.toBe(500);
    });
    expect([200, 503]).toContain(ready.status);

    const validate = openapiValidator('#/components/schemas/Health');
    const valid = validate(ready.body);
    if (!valid) {
      throw new Error(
        `Health body does not validate: ${JSON.stringify(
          validate.errors,
          null,
          2,
        )}`,
      );
    }
    expect(['ok', 'degraded']).toContain(ready.body.status);
    if (ready.status === 503) {
      expect(ready.body.status).toBe('degraded');
    } else {
      expect(ready.body.status).toBe('ok');
    }
    collectedStatuses.push(ready.status);
    collectedBodies.push(ready.body);
  });

  it('forces the readiness-503 path: a non-coded ServiceUnavailableException is not flattened to 500', async () => {
    setConsumerStatus('down');
    try {
      const ready = await request(app.getHttpServer()).get('/health/ready');

      check('readiness with the consumer down must answer exactly 503', () => {
        expect(ready.status).toBe(503);
      });
      expect(ready.body.status).toBe('degraded');
      expect(ready.body.checks.consumer).toBe('down');

      const validate = openapiValidator('#/components/schemas/Health');
      if (!validate(ready.body)) {
        throw new Error(
          `Degraded Health body does not validate: ${JSON.stringify(
            validate.errors,
            null,
            2,
          )}`,
        );
      }

      if (isRecord(ready.body) && 'details' in ready.body) {
        assertNoInternalKeys(ready.body.details);
      }

      collectedStatuses.push(ready.status);
      collectedBodies.push(ready.body);
    } finally {
      resetConsumerStatus();
    }
  });

  it('SC-007a: a foreign and a nonexistent program are indistinguishable', async () => {
    expect(scopedRoutes.length).toBeGreaterThan(0);
    const correlationId = `sc007a-${randomUUID()}`;
    const nonexistentProgramId = randomUUID();

    for (const route of scopedRoutes) {
      const foreign = await send(
        route.method,
        concretePath(route.path, programB, 'INV-1'),
        { ...NO_OPTIONS, token: tokenAll, correlationId },
      );
      const missing = await send(
        route.method,
        concretePath(route.path, nonexistentProgramId, 'INV-1'),
        { ...NO_OPTIONS, token: tokenAll, correlationId },
      );

      check(`SC-007a ${routeLabel(route)}`, () => {
        expect(foreign.status).toBe(404);
        expect(missing.status).toBe(404);
        // Both are NOT_FOUND with the same correlation id: byte-comparable, so
        // existence outside the caller's organisation is not disclosed.
        expect(foreign.body).toEqual(missing.body);
      });

      collectedStatuses.push(foreign.status, missing.status);
      collectedBodies.push(foreign.body, missing.body);
    }
  });

  it('never answers 500 and never leaks stack/sql/query inside details', () => {
    expect(collectedStatuses).not.toContain(500);

    for (const body of collectedBodies) {
      if (isRecord(body) && 'details' in body) {
        assertNoInternalKeys(body.details);
      }
    }
  });
});
