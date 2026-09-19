import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { load } from 'js-yaml';

const CONTRACT_PATH = join(
  __dirname,
  '..',
  '..',
  'specs',
  '001-program-capacity-reservation',
  'contracts',
  'http-api.yaml',
);

// The document has no `$id` of its own, so a base id is supplied when it is
// registered. OpenAPI 3.1 schemas are JSON Schema 2020-12, which is why the
// 2020 dialect is required; the default Ajv export rejects them.
const BASE_ID = 'https://capacity.invalid/contracts/http-api.yaml';

let compiled: Ajv2020 | null = null;

function compile(): Ajv2020 {
  const document = load(readFileSync(CONTRACT_PATH, 'utf8'));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  // The whole document is registered so internal `$ref`s such as
  // `#/components/schemas/Money` resolve against the base id.
  ajv.addSchema(document as object, BASE_ID);
  return ajv;
}

export function openapiValidator(schemaRef: string): ValidateFunction {
  if (compiled === null) {
    compiled = compile();
  }
  const ref = schemaRef.startsWith('#') ? `${BASE_ID}${schemaRef}` : schemaRef;
  const validator = compiled.getSchema(ref);
  if (validator === undefined) {
    throw new Error(`No schema is registered for ${schemaRef}`);
  }
  return validator;
}
