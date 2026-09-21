import * as vm from 'node:vm';
import type { OpenAPIObject } from '@nestjs/swagger';
import {
  buildOpenApiDocumentWithoutDatabase,
  type OpenApiTestDocument,
} from '../support/openapi-document';

interface MetaSchemaValidator {
  validate(schema: Record<string, unknown>): Promise<{
    valid: boolean;
    errors?: unknown[] | string;
  }>;
}

interface ValidatorModule {
  Validator: new () => MetaSchemaValidator;
}

// `@seriousme/openapi-schema-validator` is ESM-only, and this repository's ts-jest config
// compiles to CommonJS, so a static `import` cannot load it. A dynamic import evaluated
// outside Jest's CommonJS module registry loads it through the native ESM loader.
const loadEsmModule = (specifier: string): Promise<unknown> =>
  vm.runInNewContext(`import(${JSON.stringify(specifier)})`, {}, {
    importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  }) as Promise<unknown>;

describe('openapi meta-schema validity', () => {
  let built: OpenApiTestDocument;
  let document: OpenAPIObject;
  let Validator: new () => MetaSchemaValidator;

  beforeAll(async () => {
    built = await buildOpenApiDocumentWithoutDatabase();
    document = built.document;

    const validatorModule = (await loadEsmModule(
      '@seriousme/openapi-schema-validator',
    )) as ValidatorModule;
    Validator = validatorModule.Validator;
  });

  afterAll(async () => {
    await built.close();
  });

  it('the generated document describes operations, not just schemas', () => {
    // An empty module renders `paths = {}`; every operation-level assertion below would
    // then pass without validating anything. Fail loudly if the document regresses.
    expect(Object.keys(document.paths ?? {}).length).toBeGreaterThan(0);
  });

  it('the generated document satisfies the OpenAPI 3.1 meta-schema', async () => {
    expect(
      document.openapi.startsWith('3.1') ||
        `the generated document declares OpenAPI dialect '${document.openapi}', not '3.1'`,
    ).toBe(true);

    const result = await new Validator().validate(document as unknown as Record<string, unknown>);
    expect(result.valid || JSON.stringify(result.errors, null, 2)).toBe(true);
  });
});
