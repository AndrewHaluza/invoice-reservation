import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import type {
  OpenAPIObject,
  OperationObject,
  ParameterObject,
  ReferenceObject,
} from '@nestjs/swagger';
import { load } from 'js-yaml';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { REFUSAL_STATUS } from '../../src/capacity/api/error.filter';
import { REFUSAL_CODES } from '../../src/capacity/domain/errors';
import { buildOpenApiDocument } from '../../src/docs';
import { createValidationPipe } from '../../src/shared/validation/create-validation-pipe';
import { PostgresFixture, startPostgres } from '../support/postgres-container';
import { RedisFixture, startRedis } from '../support/redis-container';

jest.setTimeout(180_000);

const JWT_SECRET = 'integration-test-secret-0123456789abcdef';

const CONTRACT_PATH = join(
  __dirname,
  '..',
  '..',
  'specs',
  '001-program-capacity-reservation',
  'contracts',
  'http-api.yaml',
);

const METHOD_NAMES = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;
type MethodName = (typeof METHOD_NAMES)[number];

const EXPECTED_OPERATION_IDS = [
  'cancelReservation',
  'createRelease',
  'createReservation',
  'getAvailability',
  'getReservation',
  'listLedgerEntries',
  'listReservations',
  'live',
  'ready',
];

const IDEMPOTENT_OPERATION_IDS = [
  'createReservation',
  'createRelease',
  'cancelReservation',
];

const savedEnv = new Map<string, string | undefined>();

const setEnv = (key: string, value: string): void => {
  savedEnv.set(key, process.env[key]);
  process.env[key] = value;
};

// `@nestjs/swagger` emits `{param}` segments, but Express registers `:param`.
// Normalise either spelling before comparing so the direction of the
// conversion never decides whether a route counts as documented.
const normalisePath = (path: string): string =>
  path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

interface CollectedOperation {
  readonly path: string;
  readonly method: MethodName;
  readonly operation: OperationObject;
}

const collectOperations = (
  paths: OpenAPIObject['paths'],
): CollectedOperation[] => {
  const collected: CollectedOperation[] = [];
  for (const [path, item] of Object.entries(paths)) {
    for (const method of METHOD_NAMES) {
      const operation = item[method];
      if (operation !== undefined) {
        collected.push({ path: normalisePath(path), method, operation });
      }
    }
  }
  return collected;
};

const routeKey = (route: { path: string; method: MethodName }): string =>
  `${route.method.toUpperCase()} ${route.path}`;

const findOperation = (
  paths: OpenAPIObject['paths'],
  path: string,
  method: MethodName,
): OperationObject | undefined => paths[path]?.[method];

// The generated document carries these as vendor extensions; the OpenAPI
// interface does not model them, so the extension is read through one narrow,
// explicitly named shape rather than by widening the whole operation.
type ExtendedOperation = OperationObject & { readonly 'x-required-scope'?: string };

const requiredScopeOf = (operation: OperationObject): string | undefined =>
  (operation as ExtendedOperation)['x-required-scope'];

const isReference = (value: unknown): value is ReferenceObject =>
  typeof value === 'object' && value !== null && '$ref' in value;

const isParameterObject = (
  value: ParameterObject | ReferenceObject,
): value is ParameterObject => !isReference(value);

const responseDescription = (
  responses: OperationObject['responses'],
  status: string,
): string | undefined => {
  const response = responses[status];
  if (response === undefined || isReference(response)) {
    return undefined;
  }
  return response.description;
};

const stripForComparison = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, '');

const deleteVendorExtensions = (value: unknown): void => {
  if (Array.isArray(value)) {
    for (const item of value) {
      deleteVendorExtensions(item);
    }
    return;
  }
  if (typeof value !== 'object' || value === null) {
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key.startsWith('x-')) {
      delete record[key];
    } else {
      deleteVendorExtensions(record[key]);
    }
  }
};

interface ExpressRoute {
  readonly path: string;
  readonly methods: Record<string, boolean>;
}

interface ExpressStackEntry {
  readonly route?: ExpressRoute;
}

interface ExpressRouter {
  readonly stack?: readonly ExpressStackEntry[];
}

interface ExpressInstance {
  readonly router?: ExpressRouter;
  readonly _router?: ExpressRouter;
}

interface LiveRoute {
  readonly path: string;
  readonly method: MethodName;
}

// Express 4 exposes the router as `_router`; Express 5 renamed it to `router`.
// If neither yields a stack the drift gate is unreadable and the suite must say
// so loudly rather than silently drop half of it.
const liveRoutes = (app: INestApplication): LiveRoute[] => {
  const instance = app.getHttpAdapter().getInstance() as ExpressInstance;
  const stack = (instance.router ?? instance._router)?.stack;
  if (!Array.isArray(stack)) {
    throw new Error(
      'Cannot read the Express route table: neither `router` nor `_router` exposes a stack. ' +
        'Assertions 1 and 2 are the drift gate; refusing to drop them. Stop and report.',
    );
  }

  const routes: LiveRoute[] = [];
  for (const entry of stack) {
    const route = entry.route;
    if (route === undefined) {
      continue;
    }
    const path = normalisePath(route.path);
    // `/docs` is mounted by SwaggerModule as middleware, not by a Nest route.
    // A wildcard path is a middleware mount too: Express 5 represents
    // `app.use(path, fn)` as a per-verb route on the wildcard, so the global
    // CorrelationMiddleware and pino logger appear as `{*splat}`. They are not
    // operations, and no Nest controller declares a `*`. Middleware is not an
    // undocumented route; an endpoint path never contains a wildcard.
    if (path.startsWith('/docs') || path.includes('*')) {
      continue;
    }
    for (const method of METHOD_NAMES) {
      if (route.methods[method] === true) {
        routes.push({ path, method });
      }
    }
  }
  return routes;
};

const disconnectStorage = async (app: INestApplication): Promise<void> => {
  const storage = app.get(ThrottlerStorage) as ThrottlerStorageRedisService;
  await app.close();
  storage.redis.disconnect();
};

describe('OpenAPI conformance against the live router and the 001 contract', () => {
  let postgres: PostgresFixture;
  let redis: RedisFixture;
  let owner: DataSource;
  let app: INestApplication;
  let document: OpenAPIObject;
  let contract: OpenAPIObject;
  let routes: LiveRoute[];

  beforeAll(async () => {
    postgres = await startPostgres();
    redis = await startRedis();

    setEnv('MIGRATION_DATABASE_URL', postgres.ownerUrl);
    setEnv('DATABASE_URL', postgres.ownerUrl);
    setEnv('REDIS_URL', redis.url);
    setEnv('KAFKA_BROKERS', 'localhost:9093');
    setEnv('KAFKA_LAG_PROBE_ENABLED', 'false');
    setEnv('KAFKA_SASL_USERNAME', 'capacity');
    setEnv('KAFKA_SASL_PASSWORD', 'capacity_local_dev');
    setEnv('JWT_SECRET', JWT_SECRET);

    const { dataSourceOptions } = await import('../../src/config/data-source');
    owner = new DataSource({
      ...dataSourceOptions,
      url: postgres.ownerUrl,
      entities: [],
    });
    await owner.initialize();
    await owner.runMigrations();

    setEnv('DATABASE_URL', postgres.appUrl);

    const { AppModule } = await import('../../src/app.module');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    await app.init();

    document = buildOpenApiDocument(app, 4010, '0.1.0');
    // The oracle is YAML; the OpenAPI 3.1 shape is not expressible by the loader,
    // so this single cast is the type boundary for the whole file.
    contract = load(readFileSync(CONTRACT_PATH, 'utf8')) as OpenAPIObject;
    routes = liveRoutes(app);

    // One-shot confirmation that the generated keys already use `{param}` form.
    console.log('generated document paths:', Object.keys(document.paths));
    console.log(
      'live router routes:',
      routes.map((route) => routeKey(route)),
    );
  });

  afterAll(async () => {
    if (app !== undefined) {
      await disconnectStorage(app);
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

  it('1. every live route appears in the document (router is a subset of the document)', () => {
    const documented = new Set(
      collectOperations(document.paths).map((operation) => routeKey(operation)),
    );
    const undocumented = routes
      .map((route) => routeKey(route))
      .filter((key) => !documented.has(key));

    expect(undocumented).toEqual([]);
  });

  it('2. every documented operation appears in the live router (document is a subset of the router)', () => {
    const live = new Set(routes.map((route) => routeKey(route)));
    const absent = collectOperations(document.paths)
      .map((operation) => routeKey(operation))
      .filter((key) => !live.has(key));

    expect(absent).toEqual([]);
  });

  it('3. the document and the contract declare the same path-and-method set', () => {
    expect(
      collectOperations(document.paths)
        .map((operation) => routeKey(operation))
        .sort(),
    ).toEqual(
      collectOperations(contract.paths)
        .map((operation) => routeKey(operation))
        .sort(),
    );
  });

  it('4. operationIds match the contract and the full sorted list is exact', () => {
    for (const { path, method, operation } of collectOperations(contract.paths)) {
      const generated = findOperation(document.paths, path, method);
      expect(generated).toBeDefined();
      expect(generated?.operationId).toBe(operation.operationId);
    }

    const operationIds = collectOperations(document.paths)
      .map((operation) => operation.operation.operationId)
      .sort();
    expect(operationIds).toEqual(EXPECTED_OPERATION_IDS);
  });

  it('5. every operation carries exactly the contract tags', () => {
    for (const { path, method, operation } of collectOperations(contract.paths)) {
      const generated = findOperation(document.paths, path, method);
      expect(generated?.tags).toEqual(operation.tags);
      expect(generated?.tags).toHaveLength(1);
    }
  });

  it('6. x-required-scope matches, including the operations that declare none', () => {
    for (const { path, method, operation } of collectOperations(contract.paths)) {
      const generated = findOperation(document.paths, path, method);
      expect(generated).toBeDefined();
      const actual =
        generated === undefined ? undefined : requiredScopeOf(generated);
      expect(actual).toBe(requiredScopeOf(operation));
    }
  });

  it('7. response code sets match the contract', () => {
    for (const { path, method, operation } of collectOperations(contract.paths)) {
      const generated = findOperation(document.paths, path, method);
      expect(generated).toBeDefined();
      expect(Object.keys(generated?.responses ?? {}).sort()).toEqual(
        Object.keys(operation.responses).sort(),
      );
    }
  });

  it('8. the health probes declare an empty security array', () => {
    expect(document.paths['/health/live']?.get?.security).toEqual([]);
    expect(document.paths['/health/ready']?.get?.security).toEqual([]);
  });

  it('9. every non-health operation inherits document-level security', () => {
    for (const { path, operation } of collectOperations(document.paths)) {
      if (path.startsWith('/health')) {
        continue;
      }
      expect(operation.security).toBeUndefined();
    }
  });

  it('10. every operation has a substantive, non-path summary', () => {
    for (const { path, operation } of collectOperations(document.paths)) {
      const summary = operation.summary ?? '';
      expect(summary.length).toBeGreaterThanOrEqual(20);
      expect(stripForComparison(summary)).not.toBe(stripForComparison(path));
    }
  });

  it('11. the idempotent writes require a documented Idempotency-Key', () => {
    const operations = collectOperations(document.paths);
    for (const operationId of IDEMPOTENT_OPERATION_IDS) {
      const generated = operations.find(
        (operation) => operation.operation.operationId === operationId,
      );
      expect(generated).toBeDefined();

      const parameter = (generated?.operation.parameters ?? []).find(
        (candidate): candidate is ParameterObject =>
          isParameterObject(candidate) &&
          candidate.in === 'header' &&
          candidate.name === 'Idempotency-Key',
      );
      expect(parameter).toBeDefined();
      expect(parameter?.required).toBe(true);

      const schema = parameter?.schema;
      expect(schema).toBeDefined();
      if (schema === undefined || isReference(schema)) {
        throw new Error(
          `Idempotency-Key on ${operationId} must have an inline schema`,
        );
      }
      expect(schema.minLength).toBe(8);
      expect(schema.maxLength).toBe(128);
      expect(parameter?.description).toContain('IDEMPOTENCY_CONFLICT');
      expect(parameter?.description).toContain('original outcome');
    }
  });

  it('12. every refusal code is documented and 503 never means anything else', () => {
    const serialised = JSON.stringify(document);
    for (const code of REFUSAL_CODES) {
      expect(serialised).toContain(code);
    }

    expect(REFUSAL_STATUS.POSITION_UNVERIFIED).toBe(503);

    for (const { path, method, operation } of collectOperations(contract.paths)) {
      if (!('503' in operation.responses)) {
        continue;
      }
      const generated = findOperation(document.paths, path, method);
      expect(Object.keys(generated?.responses ?? {})).toContain('503');
    }
  });

  it('13. 404s and 403s never disclose whether a program exists', () => {
    let notFoundChecked = 0;
    let forbiddenChecked = 0;

    for (const { operation } of collectOperations(document.paths)) {
      const notFound = responseDescription(operation.responses, '404');
      if (notFound !== undefined) {
        notFoundChecked += 1;
        expect(/\b(organisation|another)\b/i.test(notFound)).toBe(true);
      }

      const forbidden = responseDescription(operation.responses, '403');
      if (forbidden !== undefined) {
        forbiddenChecked += 1;
        expect(/\bscope\b/i.test(forbidden)).toBe(true);
        expect(/\bexist\b/i.test(forbidden)).toBe(false);
      }
    }

    expect(notFoundChecked).toBeGreaterThan(0);
    expect(forbiddenChecked).toBeGreaterThan(0);
  });

  it('14. vendor extensions are not load-bearing', () => {
    const stripped: OpenAPIObject = structuredClone(document);
    deleteVendorExtensions(stripped as unknown as Record<string, unknown>);

    expect(
      collectOperations(stripped.paths)
        .map((operation) => routeKey(operation))
        .sort(),
    ).toEqual(
      collectOperations(document.paths)
        .map((operation) => routeKey(operation))
        .sort(),
    );

    for (const { operation } of collectOperations(stripped.paths)) {
      expect(typeof operation.operationId).toBe('string');
      expect(operation.responses).toBeDefined();
      expect(typeof operation.responses).toBe('object');
    }
  });

  it('15. document metadata is complete and authenticates with bearer tokens', () => {
    expect(document.openapi).toBe('3.1.0');
    expect(typeof document.info.title).toBe('string');
    expect(document.info.title.length).toBeGreaterThan(0);
    expect(typeof document.info.version).toBe('string');
    expect(document.info.version.length).toBeGreaterThan(0);

    const serverUrl = document.servers?.[0]?.url;
    expect(typeof serverUrl).toBe('string');
    expect(serverUrl?.length).toBeGreaterThan(0);

    expect(document.security).toEqual([{ bearerAuth: [] }]);
    expect(document.components?.securitySchemes?.bearerAuth).toEqual(
      expect.objectContaining({ scheme: 'bearer' }),
    );
  });

  it('16. the serialised document is self-contained', () => {
    const serialised = JSON.stringify(document, null, 2);
    expect(serialised).not.toContain('"$ref": "http');
    expect(serialised).not.toContain('"$ref": "./');
  });
});
