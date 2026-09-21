import type { OpenAPIObject } from '@nestjs/swagger';
import {
  EXPECTED_OPERATIONS,
  buildOpenApiDocumentWithoutDatabase,
  type OpenApiTestDocument,
} from '../support/openapi-document';

type Rec = Record<string, unknown>;

const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

const asRecord = (value: unknown): Rec | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : undefined;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const SCHEMA_REF_PREFIX = '#/components/schemas/';

function referencedSchemaName(schema: Rec): string | undefined {
  const direct = schema.$ref;
  if (typeof direct === 'string' && direct.startsWith(SCHEMA_REF_PREFIX)) {
    return direct.slice(SCHEMA_REF_PREFIX.length);
  }
  for (const keyword of ['allOf', 'oneOf', 'anyOf']) {
    for (const clause of asArray(schema[keyword])) {
      const clauseSchema = asRecord(clause);
      const name = clauseSchema ? referencedSchemaName(clauseSchema) : undefined;
      if (name !== undefined) return name;
    }
  }
  return undefined;
}

function declaredType(schema: Rec): string | undefined {
  if (typeof schema.type === 'string') return schema.type;
  if (Array.isArray(schema.type)) {
    const named = schema.type.filter(
      (entry): entry is string => typeof entry === 'string' && entry !== 'null',
    );
    return named[0];
  }
  return undefined;
}

interface OperationEntry {
  readonly method: string;
  readonly path: string;
  readonly operation: Rec;
}

function collectOperations(document: OpenAPIObject): OperationEntry[] {
  const operations: OperationEntry[] = [];
  const paths = (document.paths ?? {}) as Record<string, unknown>;
  for (const [path, item] of Object.entries(paths)) {
    const pathItem = asRecord(item);
    if (!pathItem) continue;
    for (const method of HTTP_METHODS) {
      const operation = asRecord(pathItem[method]);
      if (operation) operations.push({ method, path, operation });
    }
  }
  return operations;
}

function collectLeafExampleViolations(document: OpenAPIObject): string[] {
  const schemas = (document.components?.schemas ?? {}) as Record<string, unknown>;
  const violations: string[] = [];
  const visited = new Set<string>();

  const visit = (name: string, candidate: unknown): void => {
    if (visited.has(name)) return;
    visited.add(name);
    const schema = asRecord(candidate);
    if (!schema) return;
    const alias = referencedSchemaName(schema);
    if (alias !== undefined && alias !== name) {
      visit(alias, schemas[alias]);
      return;
    }
    const properties = asRecord(schema.properties);
    if (!properties) return;
    for (const [propertyName, propertyValue] of Object.entries(properties)) {
      const property = asRecord(propertyValue);
      if (!property) continue;
      const referenced = referencedSchemaName(property);
      if (referenced !== undefined) {
        visit(referenced, schemas[referenced]);
        continue;
      }
      const type = declaredType(property);
      if (type === 'object' || type === 'array') continue;
      if (property.example === undefined) {
        violations.push(`${name}.${propertyName}`);
      }
    }
  };

  for (const [name, schema] of Object.entries(schemas)) {
    visit(name, schema);
  }
  return violations;
}

function collectHeaderExampleViolations(document: OpenAPIObject): string[] {
  const violations: string[] = [];
  for (const { method, path, operation } of collectOperations(document)) {
    for (const rawParameter of asArray(operation.parameters)) {
      const parameter = asRecord(rawParameter);
      if (!parameter || parameter.in !== 'header' || parameter.required !== true) continue;
      const headerName = typeof parameter.name === 'string' ? parameter.name : '<unnamed>';
      const schema = asRecord(parameter.schema);
      const example = schema?.example;
      if (typeof example !== 'string' || example.length === 0) {
        violations.push(`${method} ${path} ${headerName}`);
      }
    }
  }
  return violations;
}

// True when an example exists directly on the schema, on any property (recursively), or
// on any `allOf`/`oneOf`/`anyOf` branch — including branches that resolve through a
// `$ref`. A request body such as `CreateReleaseDto` has a single `amount` property whose
// example lives on the `PositiveMoneyResponse` it references, so a shallow property scan
// would wrongly report it as undocumented.
function schemaCarriesExample(
  schemas: Record<string, unknown>,
  schema: Rec,
  visited: Set<string>,
): boolean {
  if (schema.example !== undefined) return true;

  const name = referencedSchemaName(schema);
  if (name !== undefined) {
    if (visited.has(name)) return false;
    visited.add(name);
    const target = asRecord(schemas[name]);
    return target !== undefined && schemaCarriesExample(schemas, target, visited);
  }

  const properties = asRecord(schema.properties);
  if (properties) {
    for (const value of Object.values(properties)) {
      const property = asRecord(value);
      if (property && schemaCarriesExample(schemas, property, visited)) return true;
    }
  }

  for (const keyword of ['allOf', 'oneOf', 'anyOf']) {
    for (const clause of asArray(schema[keyword])) {
      const clauseSchema = asRecord(clause);
      if (clauseSchema && schemaCarriesExample(schemas, clauseSchema, visited)) return true;
    }
  }

  return false;
}

function collectRequestBodyExampleViolations(document: OpenAPIObject): string[] {
  const schemas = (document.components?.schemas ?? {}) as Record<string, unknown>;
  const violations: string[] = [];
  for (const { method, path, operation } of collectOperations(document)) {
    const requestBody = asRecord(operation.requestBody);
    if (!requestBody) continue;
    const content = asRecord(requestBody.content);
    const media = content ? asRecord(content['application/json']) : undefined;
    const schema = media ? asRecord(media.schema) : undefined;
    if (!schema) {
      violations.push(`${method} ${path}`);
      continue;
    }
    const name = referencedSchemaName(schema);
    const resolved = name !== undefined ? asRecord(schemas[name]) : schema;
    if (resolved === undefined || !schemaCarriesExample(schemas, resolved, new Set())) {
      violations.push(`${method} ${path}`);
    }
  }
  return violations;
}

describe('openapi generated examples', () => {
  let built: OpenApiTestDocument;
  let document: OpenAPIObject;

  beforeAll(async () => {
    built = await buildOpenApiDocumentWithoutDatabase();
    document = built.document;
  });

  afterAll(async () => {
    await built.close();
  });

  it('describes exactly the expected operations', () => {
    // An empty module renders `paths = {}`; the header and request-body assertions below
    // would then iterate nothing and pass vacuously. Pin the operation set so they keep
    // their teeth.
    const present = collectOperations(document).map(({ method, path }) => `${method} ${path}`);
    expect([...present].sort()).toEqual([...EXPECTED_OPERATIONS].sort());
  });

  it('every leaf schema property declares an example', () => {
    expect(collectLeafExampleViolations(document)).toEqual([]);
  });

  it('every required header parameter declares an example', () => {
    expect(collectHeaderExampleViolations(document)).toEqual([]);
  });

  it('every request body schema resolves and carries at least one example', () => {
    expect(collectRequestBodyExampleViolations(document)).toEqual([]);
  });
});
