# Execution Plan: Generated OpenAPI documentation, docs UI, and project README

## Goal

The running service publishes an OpenAPI 3.1.0 document generated from its own controllers
and DTOs, serves an interactive Swagger UI page and the raw document in JSON and YAML, and
the repository carries a `README.md` that takes a developer from clean clone to a successful
API call. Automated checks fail the build when the generated document drifts from the
hand-written design contract, when money is typed as a number, or when the README references
something that does not exist. No API behaviour changes.

## Current State

Discovered by inspection during planning. All of this is fact, not assumption.

**Stack**: NestJS 11, TypeScript strict, Node `>=22.0.0 <23`, Express platform, TypeORM +
Postgres, Redis, KafkaJS. Jest with `ts-jest`.

**Routes that exist today** (from `src/capacity/api/capacity.controller.ts`,
`src/capacity/api/audit.controller.ts`, `src/observability/health.controller.ts`):

| Method | Path | Controller method |
|---|---|---|
| POST | `/v1/programs/:programId/reservations` | `CapacityController.createReservation` |
| POST | `/v1/programs/:programId/reservations/:invoiceId/releases` | `CapacityController.createRelease` |
| POST | `/v1/programs/:programId/reservations/:invoiceId/cancellation` | `CapacityController.cancelReservation` |
| GET | `/v1/programs/:programId/availability` | `CapacityController.getAvailability` |
| GET | `/v1/programs/:programId/reservations` | `CapacityController.listReservations` |
| GET | `/v1/programs/:programId/reservations/:invoiceId` | `CapacityController.getReservation` |
| GET | `/v1/programs/:programId/ledger` | `AuditController.listLedger` |
| GET | `/health/live` | `HealthController.live` |
| GET | `/health/ready` | `HealthController.ready` |

The exact controller method names must be read from the files during execution; the table
above is what planning observed. `CapacityController` method names are as listed except that
the last three read methods were observed as `@Get('availability')`, `@Get('reservations')`,
`@Get('reservations/:invoiceId')` — confirm the method identifiers in the file before
decorating.

**`specs/001-program-capacity-reservation/contracts/http-api.yaml`** is a hand-written
OpenAPI **3.1.0** document, 591 lines. It is already load-bearing:
`test/contract/*.contract.spec.ts` compile its schemas with `Ajv2020` through
`test/support/openapi.ts` and validate live HTTP responses against them, and
`scripts/verify-uat.sh` section 14 greps it for `x-required-scope`. It is **not** deleted or
edited by this plan. It becomes the oracle the generated document is compared against.

Its authoritative operation table, extracted during planning:

| operationId | Method + path | tags | x-required-scope | response codes |
|---|---|---|---|---|
| `getAvailability` | GET `/v1/programs/{programId}/availability` | `capacity` | `capacity:read` | 200,401,403,404,429 |
| `createReservation` | POST `/v1/programs/{programId}/reservations` | `capacity` | `capacity:write` | 200,201,400,401,403,404,409,429,503 |
| `listReservations` | GET `/v1/programs/{programId}/reservations` | **`audit`** | `capacity:read` | 200,401,403,404,429 |
| `getReservation` | GET `/v1/programs/{programId}/reservations/{invoiceId}` | **`audit`** | `capacity:read` | 200,401,403,404,429 |
| `createRelease` | POST `/v1/programs/{programId}/reservations/{invoiceId}/releases` | `capacity` | `capacity:write` | 200,201,400,401,403,404,409,429,503 |
| `cancelReservation` | POST `/v1/programs/{programId}/reservations/{invoiceId}/cancellation` | `capacity` | `capacity:write` | 200,201,400,401,403,404,409,429,503 |
| `listLedgerEntries` | GET `/v1/programs/{programId}/ledger` | `audit` | `capacity:audit` | 200,401,403,404,429 |
| `live` | GET `/health/live` | `health` | — | 200 |
| `ready` | GET `/health/ready` | `health` | — | 200,503 |

Note three things that contradict a casual reading and have already caused a wrong assumption
during planning:

1. `listReservations` and `getReservation` are tagged **`audit`**, not `capacity`, even though
   their scope is `capacity:read`.
2. The ledger operationId is **`listLedgerEntries`**, while the controller method is
   `listLedger`.
3. The read operations document **no `400`**, despite having validated query parameters.

Contract component shapes that the generated document must match:

- `Money`: required `amountMinor` (`type: string`, pattern `^-?[0-9]+$` — **negatives are
  allowed**, ledger deltas use them) and `currency` (`type: string`, pattern `^[A-Z]{3}$`).
- `Error`: required `code`, `message`, **and `correlationId`** (three, not two); optional
  `details` as an object whose values are strings and whose property names match
  `^[A-Za-z0-9_.\[\]]+$`.
- `Page`: required `nextCursor`, `type: ['string','null']`, described as an opaque keyset
  cursor.
- Parameters: `programId` path uuid; `Idempotency-Key` header **required**, minLength 8,
  maxLength 128; `x-correlation-id` header optional, maxLength 128; `cursor` query string;
  `limit` query integer min 1 **max 200 default 50** for reservations; ledger `limit` query
  integer min 1 **max 1000 default 100**.

**Application body types** (the shapes the handlers already return):

- `src/capacity/application/availability.projection.ts` — `MoneyBody { amountMinor: string;
  currency: string }`, `AvailabilityBody { programId, currency, creditLimit: MoneyBody,
  reserved: { total, local, treasury: MoneyBody }, available: MoneyBody, positionVerified:
  boolean, investigationRequired: boolean, reconciliationPending: boolean, overLimit: { active:
  boolean, since: string | null }, positionChangedAt: string, treasury: { appliedVersion:
  number, effectiveAt: string | null, lagSeconds: number | null } }`. All fields `readonly`.
- `src/capacity/application/reservation.projection.ts` — `ReservationFxBody { rate, effectiveAt,
  source: string }`, `ReservationBody { invoiceId, programId, status, invoiceAmount: MoneyBody,
  reserved: MoneyBody, outstanding: { invoice, reserved: MoneyBody }, fx: ReservationFxBody |
  null, createdAt: string }`.
- `src/capacity/application/audit-read.service.ts` — `Page<T> { nextCursor: string | null;
  items: readonly T[] }`, `LedgerEntryBody { sequence: number, delta: MoneyBody, component,
  cause, originReference: string | null, actor, correlationId, occurredAt: string }`,
  `ReservationStatus = InvoiceReservationEntity['status']`.
- `ReserveBody`, `ReleaseBody`, `CancelBody` are exported from
  `src/capacity/application/{reserve,release,cancel}.service.ts`. Their exact fields must be
  read from those files during Task 5.

**Request DTOs** in `src/capacity/api/dto/`: `money.dto.ts` (`MoneyDto`, `PositiveMoneyDto`
with `amountMinor` matching `^[1-9][0-9]{0,18}$`), `create-reservation.dto.ts` (`invoiceId`
`@Length(1,128)`, `amount: PositiveMoneyDto`), `create-release.dto.ts` (`amount`),
`cancellation.dto.ts` (`reason` in `['CANCELLED','WRITTEN_OFF']`, `note?` maxLength 512),
`list-reservations.query.ts` (`status?` in five values, `cursor?`, `limit?` 1–200),
`list-ledger.query.ts` (`from?`/`to?` ISO-8601, `cause?` in nine values, `cursor?`, `limit?`
1–**1000**).

**Error filter**: `src/capacity/api/error.filter.ts` declares module-private `const MESSAGES:
Record<RefusalCode, string>` and `const STATUS: Record<RefusalCode, number>`. **Neither is
exported.** `RefusalCode` is a compile-time union in `src/capacity/domain/errors.ts` with
fourteen members. The filter is `@Catch()` (catch-all) and is registered globally as
`APP_FILTER` in `src/capacity/capacity.module.ts:47`, so an unmatched route returns the
contract-shaped `404` / `NOT_FOUND` JSON body. Every emitted body includes `correlationId`.

**Boundaries**: `eslint.config.mjs` uses `eslint-plugin-boundaries` with `default: 'disallow'`.
Elements are `domain`, `application`, `infrastructure`, `api`, `treasury`, `shared`, `fx`,
`auth`, `config`, `observability`. `boundaries/include` is `['src/**/*.ts']`, so
`node_modules` packages are outside the matrix and may be imported anywhere.
`boundaries/no-unknown-files` is `'off'`. `src/main.ts` and `src/app.module.ts` match no
element pattern and are therefore unconstrained.

**Config**: `src/config/env.schema.ts` is a Joi object. `scripts/verify-uat.sh` section 6
asserts `.env.example` declares **exactly** the keys `env.schema.ts` requires, matching
`^\s*([A-Z][A-Z0-9_]*)\s*:` in the schema against `^\s*([A-Z][A-Z0-9_]*)\s*=` in the example.
Adding a key to one without the other fails UAT.

**Jest**: `roots: ['<rootDir>/src','<rootDir>/test']`, `testRegex: '.*\\.spec\\.ts$'`, so new
`*.spec.ts` files anywhere under `test/` are collected automatically.
`testPathIgnorePatterns` excludes `test/integration/ledger-recovery.spec.ts` and
`test/performance/`. `collectCoverageFrom` is `src/**/*.ts` minus `src/main.ts`,
`src/**/*.module.ts`, and `src/migrations/**` — so **`src/docs/**` counts toward the 80%
global threshold** and must be covered. `npm run test:unit` is `jest test/unit`.

**Test fixtures**: `test/support/postgres-container.ts` (`startPostgres`, `PostgresFixture`),
`test/support/redis-container.ts` (`startRedis`, `RedisFixture`),
`test/support/openapi.ts` (`openapiValidator(ref)` — compiles the 001 contract with `Ajv2020`
+ `ajv-formats` under base id `https://capacity.invalid/contracts/http-api.yaml`).
`test/contract/availability.contract.spec.ts` is the reference pattern for booting the real
app under containers with `Test.createTestingModule`.

**Seed constants** exported from `scripts/seed.ts`: `NORTHWIND_ORGANISATION_ID`
(`a1b2c3d4-0001-4000-8000-000000000001`), `CONTOSO_ORGANISATION_ID`
(`a1b2c3d4-0002-4000-8000-000000000002`), `NORTHWIND_USD_PROGRAM_ID`
(`b1b2c3d4-0001-4000-8000-000000000011`), `NORTHWIND_EUR_PROGRAM_ID`
(`b1b2c3d4-0002-4000-8000-000000000012`), `CONTOSO_USD_PROGRAM_ID`
(`b1b2c3d4-0003-4000-8000-000000000013`), `TOKEN_SCOPE`.

**There is no `README.md` at the repository root.** `docs/` contains `ASSUMPTIONS.md`,
`kafka-acls.md`, and `plans/`.

**Package facts verified against the npm registry during planning**:

- `@nestjs/swagger@11.4.7` is the newest release on the v11 line; its peers are
  `@nestjs/core ^11.0.1` and `@nestjs/common ^11.0.1`, which the project satisfies. (The
  `latest` tag is `12.0.1`, which requires NestJS 12 and **must not** be installed.)
- It bundles `swagger-ui-dist` and `js-yaml` as its own runtime dependencies, so the UI and
  YAML serialisation need no additional package.
- `DocumentBuilder` exposes `setOpenAPIVersion(version: string)`, `addServer`, `addTag`,
  `addBearerAuth(options, name)`, and `addSecurityRequirements(name, requirements?)`.
- `SwaggerCustomOptions` exposes `jsonDocumentUrl` and `yamlDocumentUrl`, so
  `SwaggerModule.setup` serves the raw document itself — no hand-written route is needed.
- `SwaggerDocumentOptions` exposes `extraModels`, `autoTagControllers`, and
  `operationIdFactory`.
- `@ApiProperty` accepts `pattern?: string | RegExp`, `minLength`, `maxLength`, `minimum`,
  `maximum`, `enum`, `example`, `nullable`, `description`, `required`, `type`, `isArray`.
- `ApiSecurity(name, requirements = [])` always writes a **non-empty** array
  `[{ [name]: requirements }]`. **There is no decorator that emits `security: []`.** The two
  health operations therefore get their empty `security` by an explicit post-processing step
  in the document factory, not by a decorator.

## Target State

- `@nestjs/swagger@11.4.7` is a runtime dependency.
- `src/docs/` is a new boundary element, declared in `eslint.config.mjs`, permitted to import
  only `shared` and `config`.
- `src/docs/openapi-metadata.ts` builds the document's static half (`info`, `servers`, `tags`,
  `securitySchemes`, document-level `security`) as a pure function of a port number.
- `src/docs/openapi-document.factory.ts` turns an initialised `INestApplication` into a
  complete `OpenAPIObject`, then returns a new object in which the two health operations carry
  `security: []`.
- `src/docs/docs.bootstrap.ts` mounts the UI at `/docs`, the JSON at `/docs/openapi.json`, and
  the YAML at `/docs/openapi.yaml` when enabled, and registers nothing at all when disabled.
- `src/main.ts` calls it once, after the global pipe and before `listen`.
- `API_DOCS_ENABLED` exists in `src/config/env.schema.ts` and `.env.example`.
- Every request DTO and a new set of response classes under `src/capacity/api/response/` carry
  `@ApiProperty` metadata; every monetary field is a string with a pattern.
- Every operation carries `@ApiOperation` with an explicit `operationId` and a business-language
  `summary`, `@ApiTags`, `@ApiExtension('x-required-scope', ...)` where applicable, the exact
  response-code set from the 001 contract, and the required `Idempotency-Key` header on writes.
- `test/contract/openapi-conformance.contract.spec.ts` fails if the generated document and the
  001 contract disagree on paths, methods, operationIds, tags, scopes, or response codes, or if
  the generated document and the live router disagree on the set of routes.
- `test/unit/openapi-schemas.spec.ts` fails if any monetary field is typed numerically.
- `README.md` exists; `test/unit/readme-references.spec.ts` fails if it names an npm script,
  a path, or an environment variable that does not exist, or contains a known local credential.
- `scripts/verify-docs.sh` and `npm run docs:verify` run the documentation gate.

## Scope

### In Scope

- Generating, serving, and verifying the OpenAPI document.
- Decorating existing controllers and DTOs, and adding response classes that mirror existing
  application body types.
- Exporting the error filter's status map so it can be asserted against.
- `README.md` and its automated reference check.
- `docs/ASSUMPTIONS.md` entries for the decisions this plan makes.

### Out of Scope

- Any change to API behaviour, routing, validation, guards, throttling, or error mapping.
- Any database schema change or migration.
- Editing `specs/001-program-capacity-reservation/contracts/http-api.yaml`.
- Editing `scripts/verify-uat.sh`.
- Enabling the `@nestjs/swagger` CLI plugin.
- Client SDK generation, a hosted documentation portal, or documenting the Kafka contract.

## Key Decisions

1. **`@nestjs/swagger@11.4.7`, pinned to the v11 line.** `latest` is `12.0.1` and requires
   NestJS 12. Install exactly `^11.4.7`.
2. **OpenAPI 3.1.0** via `DocumentBuilder.setOpenAPIVersion('3.1.0')`, matching the 001
   contract's version so the two are comparable without translation, and matching the
   `Ajv2020` dialect `test/support/openapi.ts` already uses.
3. **No CLI plugin.** Schemas come from explicit `@ApiProperty` decorators. The plugin infers
   from TypeScript types, would type money as whatever its declared type is with no pattern,
   and does not run under `ts-node` or `ts-jest`, so a document built in a test would differ
   from one built from `nest build`.
4. **Explicit `operationId` on every operation.** The default is `Controller_method`
   (`CapacityController_createReservation`), and an `operationIdFactory` cannot map
   `listLedger` to the contract's `listLedgerEntries`. Each `@ApiOperation` states its
   `operationId` literally.
5. **`autoTagControllers: false`** in `SwaggerDocumentOptions`, so tags come only from
   `@ApiTags`. This is required because `listReservations` and `getReservation` live on
   `CapacityController` but are tagged `audit` by the contract.
6. **Raw document served by `SwaggerModule.setup` itself** via `jsonDocumentUrl:
   'docs/openapi.json'` and `yamlDocumentUrl: 'docs/openapi.yaml'`. No hand-written controller,
   no runtime `js-yaml` import of our own.
7. **Health operations get `security: []` by post-processing.** No decorator can emit an empty
   array. `buildOpenApiDocument` returns a new document object — built by spreading, never by
   mutating — in which `paths['/health/live'].get.security` and
   `paths['/health/ready'].get.security` are `[]`.
8. **Document-level `security` is `[{ bearerAuth: [] }]`** via
   `.addBearerAuth({...}, 'bearerAuth')` plus `.addSecurityRequirements('bearerAuth')`, so an
   API client sets the token once at collection level.
9. **`STATUS` is exported from `error.filter.ts` as `REFUSAL_STATUS`, and a
   `REFUSAL_CODES` array is added**, so a test can assert the documented error codes against
   the mapping the service actually applies. `RefusalCode` is a compile-time union and provides
   no runtime list. The export is additive; the filter's behaviour does not change.
10. **Schema-level unit tests build a document from a minimal standalone module with
    `extraModels`, not from `AppModule`.** `SwaggerModule.createDocument` accepts
    `extraModels: Function[]`, which emits `components.schemas` for classes that no controller
    references. An empty `@Module({})` needs no database, so these tests stay Docker-free.
    Router-level assertions cannot be done this way and live in the contract suite, which boots
    the real application under the existing testcontainers fixtures.
11. **`API_DOCS_ENABLED` is a Joi `'true' | 'false'` string**, matching the existing convention
    of `KAFKA_SASL_DISABLED` and `KAFKA_LAG_PROBE_ENABLED`. Its default is `'false'` when
    `NODE_ENV === 'production'` and `'true'` otherwise.
12. **When disabled, nothing is mounted.** The global catch-all `CapacityErrorFilter` then
    answers `/docs` with the same `404` / `NOT_FOUND` body as any unknown path, so the refusal
    discloses nothing.
13. **Money keeps the contract's pattern `^-?[0-9]+$`** on the shared `MoneyResponse`, because
    ledger deltas are negative. The request-side `PositiveMoneyResponse` narrows to
    `^[1-9][0-9]{0,18}$`, matching `PositiveMoneyDto`.
14. **`Error` has three required fields — `code`, `message`, `correlationId`** — because that is
    what the filter emits and what the contract declares.
15. **`scripts/verify-uat.sh` is not modified.** Its passing unchanged is evidence that nothing
    in the existing contract moved.

## Execution Order

---

### Task 1: Install `@nestjs/swagger`, declare the `docs` boundary element, and add the config flag and npm scripts

#### Objective

Put every piece of project wiring in place that later tasks depend on, without adding any
source file that uses it yet.

#### Files

- `package.json` — add the dependency and two npm scripts.
- `package-lock.json` — regenerated by `npm install`.
- `eslint.config.mjs` — declare the `docs` boundary element and its policy.
- `src/config/env.schema.ts` — add `API_DOCS_ENABLED`.
- `.env.example` — add `API_DOCS_ENABLED`.

#### Implementation

1. Run `npm install --save @nestjs/swagger@^11.4.7`. Confirm afterwards that
   `node -p "require('./package.json').dependencies['@nestjs/swagger']"` prints a `^11.` range
   and that `node -p "require('@nestjs/swagger/package.json').version"` prints `11.4.7` or a
   higher `11.x`. If npm resolves a `12.x`, the install is wrong — pin `@nestjs/swagger@11.4.7`
   exactly and reinstall.
2. In `package.json` `scripts`, add exactly two entries, preserving the existing ones:
   - `"docs:verify": "./scripts/verify-docs.sh"`
   - `"openapi:export": "ts-node scripts/export-openapi.ts"`
3. In `eslint.config.mjs`, inside `settings['boundaries/elements']`, add one entry after the
   `observability` entry:
   `{ type: 'docs', pattern: 'src/docs/**' },`
4. In the same file, inside `rules['boundaries/dependencies'][1].policies`, add one policy
   after the `observability` policy:
   `{ from: { element: { type: 'docs' } }, allow: [{ to: [{ element: { type: 'shared' } }] }, { to: [{ element: { type: 'config' } }] }] },`
   Do not grant `docs` any other target. Do not add any policy permitting another element to
   import `docs`; `src/main.ts` matches no element and is therefore unconstrained.
5. In `src/config/env.schema.ts`, add one key to the Joi object, placed immediately after the
   `PORT` line so related keys stay together:

   ```ts
   API_DOCS_ENABLED: Joi.string()
     .valid('true', 'false')
     .default(process.env.NODE_ENV === 'production' ? 'false' : 'true'),
   ```

6. In `.env.example`, add the line `API_DOCS_ENABLED=true`. Place it immediately after the
   existing `PORT=` line. The file's format is one `KEY=value` per line; match it exactly.

#### Constraints

- Do not add any other dependency. `swagger-ui-dist` and `js-yaml` arrive transitively with
  `@nestjs/swagger` and must not be added to `package.json`.
- Do not create `src/docs/` in this task; ESLint's `boundaries/include` only matches files that
  exist, and an element with no files is inert.
- Do not modify any other Joi key, any other npm script, or any other boundary policy.
- Do not create `scripts/verify-docs.sh` or `scripts/export-openapi.ts` in this task; they are
  created in Tasks 13 and 12 respectively. The npm scripts will not run until then, which is
  expected.

#### Edge Cases

- **`npm install` resolves `@nestjs/swagger@12`**: it declares `@nestjs/core ^12.0.0`, which
  conflicts with the installed NestJS 11. Install `@nestjs/swagger@11.4.7` exactly.
- **`.env.example` and `env.schema.ts` fall out of sync**: `scripts/verify-uat.sh` section 6
  fails with a diff of the two key sets. Both files must be edited in this task.
- **Peer-dependency warning about `@fastify/static`**: expected and harmless. The project uses
  `@nestjs/platform-express`; the fastify peer is optional. Do not install it.

#### Verification

```bash
npm run typecheck
npm run lint
node -p "require('@nestjs/swagger/package.json').version"
./scripts/verify-uat.sh
```

Expected:

- `typecheck` and `lint` exit 0.
- The printed version starts with `11.`.
- `verify-uat.sh` prints `verify-uat: PASS`, including `ok: .env.example matches env.schema.ts`.

#### Completion Criteria

- [ ] `package.json` `dependencies` contains `@nestjs/swagger` on the `^11` line.
- [ ] `package-lock.json` is updated and committed.
- [ ] `package.json` `scripts` contains `docs:verify` and `openapi:export`.
- [ ] `eslint.config.mjs` declares the `docs` element and a policy allowing it only `shared` and `config`.
- [ ] `src/config/env.schema.ts` declares `API_DOCS_ENABLED`.
- [ ] `.env.example` declares `API_DOCS_ENABLED=true`.
- [ ] All four verification commands pass.

---

### Task 2: Export the refusal-status map from the error filter

#### Objective

Make the service's error-code-to-status mapping readable at runtime so a test can assert that
the documented error contract matches what the service actually does. Behaviour must not
change.

#### Files

- `src/capacity/domain/errors.ts` — add a runtime array of refusal codes.
- `src/capacity/api/error.filter.ts` — export the existing `STATUS` map under a stable name.
- `test/unit/refusal-status.spec.ts` — new test proving the exports agree with the union type.

#### Implementation

1. In `src/capacity/domain/errors.ts`, the file currently declares
   `export type RefusalCode = 'INSUFFICIENT_CAPACITY' | ... ;` — a compile-time union with
   fourteen members. Add, immediately after the type declaration, a runtime array whose
   membership is checked against the type:

   ```ts
   export const REFUSAL_CODES = [
     'INSUFFICIENT_CAPACITY',
     'PROGRAM_OVER_LIMIT',
     'DUPLICATE_INVOICE',
     'IDEMPOTENCY_CONFLICT',
     'IDEMPOTENCY_EXPIRED',
     'REQUEST_IN_FLIGHT',
     'FX_RATE_UNAVAILABLE',
     'AMOUNT_ROUNDS_TO_ZERO',
     'POSITION_UNVERIFIED',
     'INVALID_AMOUNT',
     'CURRENCY_MISMATCH',
     'RESERVATION_TERMINAL',
     'RELEASE_EXCEEDS_RESERVED',
     'NOT_FOUND',
   ] as const satisfies readonly RefusalCode[];
   ```

   Before writing it, read the actual union in the file and make the array's members match it
   exactly, in the same order the union declares them. If the union has a member not listed
   above, include it; if a listed member is absent from the union, drop it. The `satisfies`
   clause makes a mismatch a compile error.
2. In `src/capacity/api/error.filter.ts`, change the declaration
   `const STATUS: Record<RefusalCode, number> = {` to
   `export const REFUSAL_STATUS: Record<RefusalCode, number> = {`, and update the two
   in-file usages `STATUS[exception.code]` to `REFUSAL_STATUS[exception.code]`. Search the
   whole file for `STATUS` and update every reference. Leave `MESSAGES` and `CODE_BY_STATUS`
   private and unchanged.
3. Create `test/unit/refusal-status.spec.ts` asserting:
   - `REFUSAL_CODES` has no duplicate entries.
   - Every key of `REFUSAL_STATUS` appears in `REFUSAL_CODES` and vice versa.
   - `REFUSAL_STATUS.POSITION_UNVERIFIED === 503`.
   - `REFUSAL_STATUS.NOT_FOUND === 404`.
   - `REFUSAL_STATUS.INVALID_AMOUNT === 400`.
   - Every value of `REFUSAL_STATUS` is an integer between 400 and 599.

#### Constraints

- Do not change the filter's behaviour, its `@Catch()` decorator, its status values, or its
  message strings.
- Do not export `MESSAGES` — the prose is not part of the machine contract and exporting it
  would invite tests that assert on wording.
- Do not rename `RefusalCode` or `CapacityRefusal`.
- `src/capacity/domain/errors.ts` is in the `domain` element, which may import only `domain`
  and `shared`. `REFUSAL_CODES` introduces no import, so the boundary is unaffected.

#### Edge Cases

- **The union's real membership differs from the list above**: the `satisfies` clause turns a
  superfluous member into a compile error, and a missing member is caught by the
  `REFUSAL_STATUS` key-set assertion in the test. Both are build failures, which is the
  intended behaviour.
- **`STATUS` is referenced in a test file**: search `test/` for `STATUS` and update any
  reference. `test/unit/error-filter.spec.ts` exists and may reference it.

#### Verification

```bash
npm run typecheck
npm run lint
npx jest test/unit/refusal-status.spec.ts test/unit/error-filter.spec.ts
```

Expected:

- `typecheck` and `lint` exit 0.
- Both spec files pass, with `refusal-status.spec.ts` reporting at least six assertions.

#### Completion Criteria

- [ ] `REFUSAL_CODES` is exported from `src/capacity/domain/errors.ts` with a `satisfies readonly RefusalCode[]` clause.
- [ ] `REFUSAL_STATUS` is exported from `src/capacity/api/error.filter.ts` and every in-file reference is updated.
- [ ] `test/unit/refusal-status.spec.ts` exists and passes.
- [ ] `test/unit/error-filter.spec.ts` still passes.

---

### Task 3: Add the shared response schema classes — money, error, and page

#### Objective

Create the three schema classes every other documented shape composes from, matching the 001
contract's `Money`, `Error`, and `Page` component schemas exactly.

#### Files

- `src/capacity/api/response/money.response.ts` — new; `MoneyResponse`, `PositiveMoneyResponse`.
- `src/capacity/api/response/error.response.ts` — new; `ErrorResponse`.
- `src/capacity/api/response/page.response.ts` — new; `PageResponse`.
- `src/capacity/api/response/index.ts` — new; re-exports every response class.

#### Implementation

These classes exist only to carry OpenAPI metadata. They are never instantiated, never
injected, and hold no logic.

1. `money.response.ts`:

   ```ts
   import { ApiProperty } from '@nestjs/swagger';

   export class MoneyResponse {
     @ApiProperty({
       type: String,
       pattern: '^-?[0-9]+$',
       example: '150000',
       description:
         'Minor units as a decimal string. A string, not a number, because amounts exceed the safe integer range of JSON numbers and must never be parsed as a float. Negative where the value is a ledger delta.',
     })
     amountMinor!: string;

     @ApiProperty({ type: String, pattern: '^[A-Z]{3}$', example: 'USD', description: 'ISO-4217 code. Always explicit; never implied by the program.' })
     currency!: string;
   }

   export class PositiveMoneyResponse {
     @ApiProperty({ type: String, pattern: '^[1-9][0-9]{0,18}$', example: '150000', description: 'Minor units as a decimal string. Strictly positive.' })
     amountMinor!: string;

     @ApiProperty({ type: String, pattern: '^[A-Z]{3}$', example: 'USD' })
     currency!: string;
   }
   ```

2. `error.response.ts` declares `ErrorResponse` with exactly four properties, three required:
   - `code: string` — `@ApiProperty({ type: String, example: 'INSUFFICIENT_CAPACITY', description: 'Machine-readable. Branch on this, never on message.' })`
   - `message: string` — `@ApiProperty({ type: String, example: 'The amount exceeds available capacity.', description: 'Fixed human-readable prose. Never interpolates an amount, identifier, or program id.' })`
   - `correlationId: string` — `@ApiProperty({ type: String, example: '3f2a9c14-8e7b-4a51-9f10-2d6c4b8e1a37', description: 'Echoes the request correlation id, or "unknown" when none was supplied.' })`
   - `details?: Record<string, string>` — `@ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'string' }, description: 'Field-level validation information only. Never stack traces, SQL, driver messages, or identifiers belonging to another organisation. At most 20 entries.', example: { 'amount.amountMinor': 'amountMinor must be a positive integer string' } })`
3. `page.response.ts` declares `PageResponse` with one property:
   - `nextCursor: string | null` — `@ApiProperty({ type: String, nullable: true, example: null, description: 'Opaque keyset cursor. Pass it back verbatim to fetch the next page; never parse or construct one. Null on the last page.' })`

   `PageResponse` carries only `nextCursor`. Each concrete paginated response declares its own
   `items` array, mirroring how the 001 contract composes `Page` with `allOf`.
4. `index.ts` re-exports all classes from the three files above, plus the classes added in
   Task 4 once they exist. In this task it re-exports only these.

#### Constraints

- Do not add validation decorators (`@IsString` etc.) to these classes — they are response
  documentation only and are never used as a `ValidationPipe` target.
- Do not make these classes `readonly`; `@ApiProperty` reflection requires writable
  declarations and definite-assignment assertions (`!`).
- `src/capacity/api/` is the `api` element and may import only `application`, `domain`, and
  `shared`. `@nestjs/swagger` is a `node_modules` package, outside the boundary matrix.
- Do not change `src/capacity/api/dto/money.dto.ts`. `MoneyDto` and `PositiveMoneyDto` remain
  the request-validation classes; `MoneyResponse` is the documentation class.

#### Edge Cases

- **A negative amount**: `MoneyResponse.amountMinor` must accept `-` because `LedgerEntryBody.delta`
  carries negative values. Using `^[0-9]+$` here would document the ledger incorrectly.
- **`details` with a non-string value**: the contract declares `additionalProperties: { type: 'string' }`.
  The filter's `toValidationDetails` produces `Record<string, string>`, so this is accurate.
- **`nullable: true` under OpenAPI 3.1**: `@nestjs/swagger` emits `nullable: true` for 3.1 as a
  sibling keyword rather than a type union. The conformance test in Task 12 compares response
  status codes and operation identity, not schema internals, so this difference does not fail
  the build. Do not attempt to hand-craft a `type: ['string','null']` union.

#### Verification

```bash
npm run typecheck
npm run lint
```

Expected: both exit 0.

#### Completion Criteria

- [ ] The four files exist under `src/capacity/api/response/`.
- [ ] `MoneyResponse.amountMinor` has pattern `^-?[0-9]+$`; `PositiveMoneyResponse.amountMinor` has pattern `^[1-9][0-9]{0,18}$`.
- [ ] `ErrorResponse` declares `code`, `message`, `correlationId` as required and `details` as optional.
- [ ] `PageResponse` declares only `nextCursor`, nullable.
- [ ] `typecheck` and `lint` pass.

---

### Task 4: Add the operation response classes and tie them to the application body types

#### Objective

Declare a documented class for every response body the API returns, and make each one a
compile-time mirror of the application type the handler actually produces, so a drift becomes
a build error.

#### Files

- `src/capacity/api/response/availability.response.ts` — new.
- `src/capacity/api/response/reservation.response.ts` — new.
- `src/capacity/api/response/ledger-entry.response.ts` — new.
- `src/capacity/api/response/health.response.ts` — new.
- `src/capacity/api/response/index.ts` — modified; re-export the new classes.

#### Implementation

Before writing each class, open the application type it mirrors and copy its field list
exactly. The shapes observed during planning are given below; if the file differs, the file
wins.

1. `availability.response.ts` declares `AvailabilityResponse` mirroring `AvailabilityBody`
   from `src/capacity/application/availability.projection.ts`:
   `programId: string` (uuid, example `b1b2c3d4-0001-4000-8000-000000000011`),
   `currency: string`, `creditLimit: MoneyResponse`, `reserved: ReservedBreakdownResponse`
   (a nested class in the same file with `total`, `local`, `treasury`, each `MoneyResponse`),
   `available: MoneyResponse`, `positionVerified: boolean`, `investigationRequired: boolean`,
   `reconciliationPending: boolean`, `overLimit: OverLimitResponse` (nested class with
   `active: boolean` and `since: string | null`), `positionChangedAt: string`
   (`format: 'date-time'`), `treasury: TreasuryStateResponse` (nested class with
   `appliedVersion: number`, `effectiveAt: string | null` `format: 'date-time'`,
   `lagSeconds: number | null`).
2. `reservation.response.ts` declares:
   - `ReservationFxResponse` — `rate: string`, `effectiveAt: string` (`date-time`), `source: string`.
   - `ReservationResponse` mirroring `ReservationBody` — `invoiceId: string`, `programId: string`,
     `status: string` with `enum: ['ACTIVE','PARTIALLY_RELEASED','FULLY_RELEASED','CANCELLED','WRITTEN_OFF']`,
     `invoiceAmount: MoneyResponse`, `reserved: MoneyResponse`,
     `outstanding: OutstandingResponse` (nested class with `invoice` and `reserved`, each
     `MoneyResponse`), `fx: ReservationFxResponse | null` (`nullable: true`),
     `createdAt: string` (`date-time`).
   - `ReservationListResponse` — `nextCursor: string | null` (nullable, opaque cursor
     description as in Task 3) and `items: ReservationResponse[]`
     (`@ApiProperty({ type: () => [ReservationResponse] })`).
   - `ReserveResponse`, `ReleaseResponse`, and `CancelResponse`, each mirroring `ReserveBody`,
     `ReleaseBody`, and `CancelBody` from
     `src/capacity/application/{reserve,release,cancel}.service.ts`. **Read those three
     interfaces before writing these classes** and mirror them field for field, typing every
     monetary field as `MoneyResponse`.
3. `ledger-entry.response.ts` declares:
   - `LedgerEntryResponse` mirroring `LedgerEntryBody` from
     `src/capacity/application/audit-read.service.ts` — `sequence: number` (`type: 'integer'`),
     `delta: MoneyResponse`, `component: string` with an `enum` copied from the
     `PositionComponent` union in `src/capacity/domain/ledger-entry.ts`, `cause: string` with
     `enum: ['RESERVATION','RELEASE','CANCELLATION','WRITE_OFF','TREASURY_EVENT','LIMIT_CHANGE','RECONCILIATION_ADJUSTMENT','OVER_LIMIT_ONSET','OVER_LIMIT_CLEARED']`,
     `originReference: string | null` (nullable), `actor: string`, `correlationId: string`,
     `occurredAt: string` (`date-time`).
   - `LedgerListResponse` — `nextCursor: string | null` and `items: LedgerEntryResponse[]`.
4. `health.response.ts` declares `HealthResponse` — `status: string` with
   `enum: ['ok','error']`, and `checks?: Record<string, string>` as
   `@ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'string' } })`.
   Mirror the `HealthResponse` type already declared in
   `src/observability/health.controller.ts`; read it before writing.
5. At the bottom of `availability.response.ts`, `reservation.response.ts`, and
   `ledger-entry.response.ts`, add a compile-time assertion per class proving it is assignable
   to the application type it mirrors. Use this exact form, which produces no runtime code and
   no unused-variable lint error:

   ```ts
   import type { AvailabilityBody } from '../../application/availability.projection';

   // Compile-time mirror check: a field added to AvailabilityBody without a matching
   // field here is a build error, not a silent documentation lie.
   export type AvailabilityResponseMirrorsBody =
     AvailabilityResponse extends AvailabilityBody ? true : never;
   ```

   Declare one such exported type alias per mirrored class: `AvailabilityResponse`,
   `ReservationResponse`, `ReserveResponse`, `ReleaseResponse`, `CancelResponse`,
   `LedgerEntryResponse`. If the alias resolves to `never`, `typecheck` still passes — so ALSO
   add, in `test/unit/response-mirrors.spec.ts`, a compile-time consumption of each alias:

   ```ts
   const availabilityMirrors: AvailabilityResponseMirrorsBody = true;
   expect(availabilityMirrors).toBe(true);
   ```

   Assigning `true` to a `never`-resolved alias is a type error, which turns the mirror check
   into a build failure. Add one such pair of lines per alias, and one `expect` per alias.
6. Update `src/capacity/api/response/index.ts` to re-export every class and alias added here.

#### Constraints

- Do not alter any application body type to make a mirror check pass. If a mirror fails, the
  response class is wrong; fix the response class.
- Do not import anything from `infrastructure`; the `api` element may not. Where a type such as
  `ReservationStatus` resolves to `InvoiceReservationEntity['status']`, do not import the
  entity — declare the enum values as string literals in the `@ApiProperty` `enum` option and
  type the field as `string`.
- Do not use `any`.
- Nested classes (`ReservedBreakdownResponse`, `OverLimitResponse`, `TreasuryStateResponse`,
  `OutstandingResponse`) must be exported so `@nestjs/swagger` emits them as named component
  schemas.

#### Edge Cases

- **A nullable field**: use `@ApiProperty({ ..., nullable: true })` and type the property as
  `T | null`. Do not use `@ApiPropertyOptional` for a field that is always present but may be
  null — optional and nullable are different, and the contract distinguishes them.
- **An array property**: `@nestjs/swagger` cannot infer the element type from
  `ReservationResponse[]` at runtime. Always write `type: () => [ReservationResponse]`.
- **A `readonly` source field**: `AvailabilityBody`'s fields are all `readonly`. A mutable
  response class is still assignable to a readonly interface, so the mirror check passes.
- **`ReserveBody`/`ReleaseBody`/`CancelBody` turn out to be identical**: declare three separate
  classes anyway. The contract names three response schemas, and collapsing them would make a
  future divergence invisible.

#### Verification

```bash
npm run typecheck
npm run lint
npx jest test/unit/response-mirrors.spec.ts
```

Expected:

- `typecheck` exits 0 — this is the mirror check passing.
- `lint` exits 0, including the boundary rule.
- `response-mirrors.spec.ts` passes with one assertion per mirrored class.

#### Completion Criteria

- [ ] All five response files exist and are re-exported from `index.ts`.
- [ ] Every monetary field is typed `MoneyResponse` or `PositiveMoneyResponse`, never `number`.
- [ ] One exported mirror alias exists per mirrored class.
- [ ] `test/unit/response-mirrors.spec.ts` consumes every alias and passes.
- [ ] `typecheck` and `lint` pass.

---

### Task 5: Decorate the request DTOs

#### Objective

Give every request body and query class the OpenAPI metadata that states its constraints, with
each constraint matching the `class-validator` rule already on the field.

#### Files

- `src/capacity/api/dto/money.dto.ts` — modified.
- `src/capacity/api/dto/create-reservation.dto.ts` — modified.
- `src/capacity/api/dto/create-release.dto.ts` — modified.
- `src/capacity/api/dto/cancellation.dto.ts` — modified.
- `src/capacity/api/dto/list-reservations.query.ts` — modified.
- `src/capacity/api/dto/list-ledger.query.ts` — modified.

#### Implementation

Add `@ApiProperty` / `@ApiPropertyOptional` alongside the existing `class-validator`
decorators. Do not remove or reorder any existing decorator.

1. `money.dto.ts`: on `MoneyDto.amountMinor`, `@ApiProperty({ type: String, pattern: '^-?[0-9]+$', example: '150000' })`;
   on `MoneyDto.currency`, `@ApiProperty({ type: String, pattern: '^[A-Z]{3}$', example: 'USD' })`;
   on `PositiveMoneyDto.amountMinor`, `@ApiProperty({ type: String, pattern: '^[1-9][0-9]{0,18}$', example: '150000', description: 'Minor units as a decimal string. Strictly positive.' })`.
   Read the file first: `PositiveMoneyDto extends MoneyDto` and redeclares `amountMinor` with
   `declare`. Apply the decorator to the redeclared member.
2. `create-reservation.dto.ts`:
   - `invoiceId`: `@ApiProperty({ type: String, minLength: 1, maxLength: 128, example: 'INV-2026-000481', description: 'The financing client\'s own invoice identifier. Unique per program.' })`
   - `amount`: `@ApiProperty({ type: () => PositiveMoneyResponse, description: 'Amount to reserve, in the program currency or a currency convertible to it.' })` — import `PositiveMoneyResponse` from `../response`.
3. `create-release.dto.ts`: `amount`: `@ApiProperty({ type: () => PositiveMoneyResponse, description: 'Amount to release. Must be denominated in the invoice\'s own currency and must not exceed what remains reserved.' })`
4. `cancellation.dto.ts`:
   - `reason`: `@ApiProperty({ type: String, enum: ['CANCELLED', 'WRITTEN_OFF'], example: 'CANCELLED', description: 'CANCELLED returns the full reserved amount to available capacity. WRITTEN_OFF closes the reservation as an unrecoverable loss.' })`
   - `note`: `@ApiPropertyOptional({ type: String, maxLength: 512, example: 'Buyer withdrew the order before shipment.' })`
5. `list-reservations.query.ts`:
   - `status`: `@ApiPropertyOptional({ type: String, enum: ['ACTIVE','PARTIALLY_RELEASED','FULLY_RELEASED','CANCELLED','WRITTEN_OFF'] })`
   - `cursor`: `@ApiPropertyOptional({ type: String, description: 'Opaque keyset cursor from a previous page\'s nextCursor. Pass it back verbatim; never parse or construct one.' })`
   - `limit`: `@ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 200, default: 50 })`
6. `list-ledger.query.ts`:
   - `from`: `@ApiPropertyOptional({ type: String, format: 'date-time', description: 'Inclusive lower bound on occurredAt.' })`
   - `to`: `@ApiPropertyOptional({ type: String, format: 'date-time', description: 'Exclusive upper bound on occurredAt.' })`
   - `cause`: `@ApiPropertyOptional({ type: String, enum: ['RESERVATION','RELEASE','CANCELLATION','WRITE_OFF','TREASURY_EVENT','LIMIT_CHANGE','RECONCILIATION_ADJUSTMENT','OVER_LIMIT_ONSET','OVER_LIMIT_CLEARED'] })`
   - `cursor`: same description as above.
   - `limit`: `@ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 1000, default: 100, description: 'The ledger is a bulk audit read and admits a larger page than the reservation list.' })`

#### Constraints

- Every documented bound must equal the `class-validator` bound on the same field. `limit` on
  the ledger is **1–1000**, not 1–200; `note` is 512, not 128.
- Do not enable the `@nestjs/swagger` CLI plugin in `nest-cli.json`.
- Do not change any validation behaviour, any decorator order that affects validation, or the
  `declare` modifier on `PositiveMoneyDto.amountMinor`.
- Do not add `@ApiProperty` to a field that does not exist.

#### Edge Cases

- **`PositiveMoneyDto` redeclares an inherited member**: `@ApiProperty` on the subclass member
  overrides the inherited schema. Both declarations must carry a decorator or the subclass will
  document the base pattern.
- **`type: 'integer'` versus `type: Number`**: use the string form `'integer'` so the emitted
  schema is `type: integer`, matching the contract's `limit` parameters.
- **A query DTO field typed `LedgerCause` or `ReservationStatus`**: keep the TypeScript type as
  it is and supply the values through the `enum` option as string literals. Do not widen the
  field's type.

#### Verification

```bash
npm run typecheck
npm run lint
npx jest test/unit/create-reservation-dto.spec.ts
```

Expected:

- All three exit 0. The existing DTO validation spec must still pass unchanged — proof that
  adding documentation metadata changed no validation behaviour.

#### Completion Criteria

- [ ] All six DTO files carry `@ApiProperty` or `@ApiPropertyOptional` on every declared field.
- [ ] Ledger `limit` documents maximum 1000; reservations `limit` documents maximum 200.
- [ ] No `class-validator` decorator was removed or reordered.
- [ ] `nest-cli.json` is unchanged.
- [ ] `test/unit/create-reservation-dto.spec.ts` passes.

---

### Task 6: Build the document metadata module

#### Objective

Produce the static half of the OpenAPI document — everything that does not come from the
router — as a pure function, unit-tested without booting anything.

#### Files

- `src/docs/openapi-metadata.ts` — new.
- `src/docs/index.ts` — new; re-exports the element's public surface.
- `test/unit/openapi-metadata.spec.ts` — new.

#### Implementation

1. `src/docs/openapi-metadata.ts` exports one function:

   ```ts
   import { DocumentBuilder } from '@nestjs/swagger';
   import type { OpenAPIObject } from '@nestjs/swagger';

   export const DOCS_TITLE = 'Program Capacity & Invoice Reservation API';

   export const DOCS_DESCRIPTION = [
     'Real-time capacity position for financing programs.',
     'Every endpoint except the health probes requires a bearer token.',
     'A caller reaches only the programs owned by the organisation its token identifies;',
     'anything else resolves to 404, never 403, so the API never reveals whether an',
     'out-of-scope program exists. A 403 means the credential lacks the required scope,',
     'which says nothing about any program.',
     'Reads are limited to 600 requests per minute per calling organisation and writes to 120;',
     'exceeding either returns 429 with the standard error body. The budgets are per',
     'organisation, so one tenant cannot deny service to another.',
     'All monetary amounts are integer strings in minor units with an explicit ISO-4217',
     'currency. They are never JSON numbers.',
   ].join(' ');

   export function buildDocumentConfig(port: number, version: string): Omit<OpenAPIObject, 'paths'> {
     return new DocumentBuilder()
       .setOpenAPIVersion('3.1.0')
       .setTitle(DOCS_TITLE)
       .setDescription(DOCS_DESCRIPTION)
       .setVersion(version)
       .addServer(`http://localhost:${port}`, 'Local development')
       .addBearerAuth(
         { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
         'bearerAuth',
       )
       .addSecurityRequirements('bearerAuth')
       .addTag('capacity', 'Reserve, release, and cancel capacity, and read a program position')
       .addTag('audit', 'Read reservations and the append-only ledger behind a position')
       .addTag('health', 'Liveness and readiness probes. No credential required.')
       .build();
   }
   ```

   `version` is supplied by the caller rather than read from disk here, so this module has no
   filesystem dependency and stays trivially testable.
2. `src/docs/index.ts` re-exports `buildDocumentConfig`, `DOCS_TITLE`, and `DOCS_DESCRIPTION`.
   It will also re-export the factory and bootstrap functions once Tasks 7 and 8 add them.
3. `test/unit/openapi-metadata.spec.ts` calls `buildDocumentConfig(4010, '0.1.0')` and asserts:
   - `openapi === '3.1.0'`
   - `info.title === DOCS_TITLE`
   - `info.version === '0.1.0'`
   - `info.description` contains the substring `404, never 403`
   - `servers[0].url === 'http://localhost:4010'`
   - `components.securitySchemes.bearerAuth` deep-equals `{ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }`
   - `security` deep-equals `[{ bearerAuth: [] }]`
   - `tags.map(t => t.name)` deep-equals `['capacity', 'audit', 'health']`

#### Constraints

- `src/docs/` is the `docs` boundary element and may import only `shared` and `config`. This
  file imports neither — only `@nestjs/swagger`, which is outside the matrix. Do not import
  `@nestjs/config`, `package.json`, or anything from `capacity`.
- Do not read `package.json` in this module; the version arrives as an argument.
- The three tag names must be exactly `capacity`, `audit`, `health`, in that order.

#### Edge Cases

- **`setOpenAPIVersion` absent**: it exists on `@nestjs/swagger@11.4.7`'s `DocumentBuilder`,
  verified during planning. If `typecheck` reports it missing, the installed version is wrong —
  stop and report, do not work around it.
- **A port of 0 or a non-numeric port**: the caller supplies a validated `PORT`; this function
  performs no validation and interpolates whatever it is given. That is intentional.

#### Verification

```bash
npm run typecheck
npm run lint
npx jest test/unit/openapi-metadata.spec.ts
```

Expected: all exit 0; the spec reports eight passing assertions.

#### Completion Criteria

- [ ] `src/docs/openapi-metadata.ts` and `src/docs/index.ts` exist.
- [ ] `buildDocumentConfig` returns `openapi: '3.1.0'`, a `bearerAuth` scheme, document-level `security`, and the three tags.
- [ ] `test/unit/openapi-metadata.spec.ts` passes.
- [ ] `npm run lint` passes with the `docs` boundary policy in force.

---

### Task 7: Build the document factory, including the health security override

#### Objective

Turn an initialised application into a complete `OpenAPIObject`, and give the two health
operations an empty `security` array, which no decorator can produce.

#### Files

- `src/docs/openapi-document.factory.ts` — new.
- `src/docs/index.ts` — modified; re-export the factory.
- `test/unit/openapi-schemas.spec.ts` — new; Docker-free schema assertions.

#### Implementation

1. `src/docs/openapi-document.factory.ts` exports:

   ```ts
   import type { INestApplication } from '@nestjs/common';
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
     extraModels: Function[] = [],
   ): OpenAPIObject {
     const generated = SwaggerModule.createDocument(
       app,
       buildDocumentConfig(port, version),
       { autoTagControllers: false, extraModels },
     );
     return withUnauthenticatedHealthOperations(generated);
   }
   ```

2. In the same file, implement `withUnauthenticatedHealthOperations(document)` as an
   **immutable** transformation — it constructs and returns a new document and never assigns
   into `document`:

   - Build a new `paths` object by mapping over `Object.entries(document.paths)`.
   - For each path key present in `UNAUTHENTICATED_OPERATIONS`, produce
     `{ ...pathItem, get: { ...pathItem.get, security: [] } }` when `pathItem.get` exists.
   - For every other path key, reuse the existing path item object unchanged.
   - Return `{ ...document, paths: newPaths }`.
   - If a path in `UNAUTHENTICATED_OPERATIONS` is not present in the document, leave the result
     unchanged for that key and do not throw. Task 12's conformance spec will catch a missing
     health route.
   - Keep the function under 50 lines and free of nesting deeper than 4 levels.

3. `test/unit/openapi-schemas.spec.ts` builds a Docker-free document:

   - Create a minimal module: `@Module({}) class EmptyDocsModule {}` declared inside the spec.
   - `const app = await NestFactory.create(EmptyDocsModule, { logger: false });` then
     `await app.init();`
   - `const document = buildOpenApiDocument(app, 4010, '0.1.0', [MoneyResponse, PositiveMoneyResponse, ErrorResponse, PageResponse, AvailabilityResponse, ReservationResponse, ReservationListResponse, LedgerEntryResponse, LedgerListResponse, HealthResponse, ReserveResponse, ReleaseResponse, CancelResponse, CreateReservationDto, CreateReleaseDto, CancellationDto]);`
   - `await app.close();` in `afterAll`.
   - Assert, walking `document.components.schemas` **recursively and generically**, never
     against a hand-listed field set:
     - **No monetary field is numeric.** For every property whose key matches
       `/^(amountMinor|amount|creditLimit|available|reserved|delta|total|local|treasury|limit|balance)$/i`
       within a schema, fail if its resolved `type` is `'number'` or `'integer'`. The key
       `limit` is exempt when the schema also declares `maximum`, because the pagination limit
       is legitimately an integer — encode that exemption explicitly.
     - Every schema named `MoneyResponse` or `PositiveMoneyResponse` has
       `required` containing both `amountMinor` and `currency`.
     - `MoneyResponse.properties.amountMinor.type === 'string'` and its `pattern` is
       `'^-?[0-9]+$'`; its `example` is a string.
     - `MoneyResponse.properties.currency.pattern === '^[A-Z]{3}$'`.
     - `PositiveMoneyResponse.properties.amountMinor.pattern === '^[1-9][0-9]{0,18}$'`.
     - `ErrorResponse.required` deep-equals `['code', 'message', 'correlationId']` in any order.
     - Every schema property whose key is `nextCursor` declares `nullable: true`.

#### Constraints

- Do not mutate the object returned by `SwaggerModule.createDocument`. The project's coding
  standard forbids in-place mutation; build new objects.
- Do not import `AppModule` in `test/unit/openapi-schemas.spec.ts` — it would require Postgres
  and Redis and turn a unit test into a container test.
- Do not add `src/docs/openapi-document.factory.ts` to any Nest module's `providers`; it is a
  plain function called from `main.ts`.
- `autoTagControllers: false` is required, not optional.

#### Edge Cases

- **`document.paths` is empty** (the unit test's empty module): the transformation must return
  a document with an empty `paths` object and must not throw.
- **A health path item without a `get`**: skip it rather than writing `security` onto
  `undefined`.
- **`NestFactory.create` of an empty module logs a banner**: pass `{ logger: false }` to keep
  the test output clean.
- **The unit test leaks an open handle**: always `await app.close()` in `afterAll`, or Jest
  reports the suite as not exiting.

#### Verification

```bash
npm run typecheck
npm run lint
npx jest test/unit/openapi-schemas.spec.ts test/unit/openapi-metadata.spec.ts
```

Expected:

- Both specs pass. `openapi-schemas.spec.ts` must report a failure if any monetary field is
  numeric — verify this by temporarily changing `MoneyResponse.amountMinor` to
  `@ApiProperty({ type: Number })`, observing the test fail, then reverting. Do not commit the
  temporary change.

#### Completion Criteria

- [ ] `buildOpenApiDocument` exists, takes `(app, port, version, extraModels?)`, and passes `autoTagControllers: false`.
- [ ] The health security override builds a new object and mutates nothing.
- [ ] `test/unit/openapi-schemas.spec.ts` passes and is Docker-free.
- [ ] The deliberate-failure check in Verification was performed and reverted.
- [ ] `lint` passes with the `docs` boundary policy in force.

---

### Task 8: Decorate the capacity controller

#### Objective

Give all six `CapacityController` operations the exact identity, tags, headers, and
response-code sets the 001 contract declares.

#### Files

- `src/capacity/api/capacity.controller.ts` — modified.

#### Implementation

Add decorators only. Do not change any method signature, any parameter decorator, any guard,
any `@SkipThrottle`, or any body.

The required per-operation metadata, taken from the 001 contract:

| method | operationId | tag | scope | response codes |
|---|---|---|---|---|
| `createReservation` | `createReservation` | `capacity` | `capacity:write` | 200,201,400,401,403,404,409,429,503 |
| `createRelease` | `createRelease` | `capacity` | `capacity:write` | 200,201,400,401,403,404,409,429,503 |
| `cancelReservation` | `cancelReservation` | `capacity` | `capacity:write` | 200,201,400,401,403,404,409,429,503 |
| `getAvailability` | `getAvailability` | `capacity` | `capacity:read` | 200,401,403,404,429 |
| `listReservations` | `listReservations` | **`audit`** | `capacity:read` | 200,401,403,404,429 |
| `getReservation` | `getReservation` | **`audit`** | `capacity:read` | 200,401,403,404,429 |

1. Do **not** put `@ApiTags` on the class — two of its methods belong to a different tag. Put
   `@ApiTags('capacity')` or `@ApiTags('audit')` on each method individually, per the table.
2. On each method add `@ApiOperation({ operationId: '<id>', summary: '<sentence>' })`. The
   summary must describe the business action, not restate the path. Use exactly these:
   - `createReservation` — `Reserve capacity for an approved invoice`
   - `createRelease` — `Release part or all of an invoice's reserved capacity`
   - `cancelReservation` — `Cancel a reservation, returning or writing off its capacity`
   - `getAvailability` — `Read a program's current capacity position`
   - `listReservations` — `List a program's reservations, newest first`
   - `getReservation` — `Read a single reservation by invoice id`
3. On each method add `@ApiExtension('x-required-scope', '<scope>')` per the table.
4. On each method add `@ApiParam({ name: 'programId', type: String, format: 'uuid', required: true, example: 'b1b2c3d4-0001-4000-8000-000000000011' })`, and on the three methods that take one,
   `@ApiParam({ name: 'invoiceId', type: String, required: true, example: 'INV-2026-000481' })`.
5. On every method add
   `@ApiHeader({ name: 'x-correlation-id', required: false, description: 'Echoed on the response and propagated to logs and downstream messages.', schema: { type: 'string', maxLength: 128 } })`.
6. On the three write methods add:

   ```ts
   @ApiHeader({
     name: 'Idempotency-Key',
     required: true,
     description:
       'Required, 8 to 128 characters. A replay carrying identical content returns the original outcome with status 200. A replay carrying different content is refused 409 IDEMPOTENCY_CONFLICT — the original outcome is never replayed for a differing request. Retained at least 30 days.',
     schema: { type: 'string', minLength: 8, maxLength: 128 },
   })
   ```

7. Declare responses with `@ApiResponse`. For the three write methods, exactly nine:
   - `201` — description `Created`, `type` the matching response class (`ReserveResponse`, `ReleaseResponse`, `CancelResponse`).
   - `200` — description `Replay of a previous request carrying the same Idempotency-Key and identical content`, same `type`.
   - `400` — `ErrorResponse`, description `VALIDATION_FAILED or INVALID_AMOUNT`.
   - `401` — `ErrorResponse`, description `UNAUTHORIZED. The bearer token is missing, malformed, or expired.`
   - `403` — `ErrorResponse`, description `FORBIDDEN. The credential lacks the required scope. This says nothing about whether the program exists.`
   - `404` — `ErrorResponse`, description `NOT_FOUND. The program or reservation does not exist, or it belongs to another organisation — the two are deliberately indistinguishable.`
   - `409` — `ErrorResponse`, description listing the codes the operation can raise. For `createReservation`: `INSUFFICIENT_CAPACITY, PROGRAM_OVER_LIMIT, DUPLICATE_INVOICE, IDEMPOTENCY_CONFLICT, IDEMPOTENCY_EXPIRED, REQUEST_IN_FLIGHT, FX_RATE_UNAVAILABLE, AMOUNT_ROUNDS_TO_ZERO`. For `createRelease`: `CURRENCY_MISMATCH, RESERVATION_TERMINAL, RELEASE_EXCEEDS_RESERVED, IDEMPOTENCY_CONFLICT, IDEMPOTENCY_EXPIRED, REQUEST_IN_FLIGHT`. For `cancelReservation`: `RESERVATION_TERMINAL, IDEMPOTENCY_CONFLICT, IDEMPOTENCY_EXPIRED, REQUEST_IN_FLIGHT`.
   - `429` — `ErrorResponse`, description `Rate limit exceeded for the calling organisation. Writes are limited to 120 requests per minute.`
   - `503` — `ErrorResponse`, description `POSITION_UNVERIFIED. The program position cannot be verified at this time.`
8. For the three read methods, exactly five responses: `200` with the matching type
   (`AvailabilityResponse`, `ReservationListResponse`, `ReservationResponse`), then `401`,
   `403`, `404`, `429` with `ErrorResponse` and the descriptions above, with the `429`
   description naming the read budget of 600 requests per minute.
9. Do **not** declare a `400` on the read methods. The contract declares none, and the
   conformance spec compares the sets exactly.

#### Constraints

- Do not add `@ApiTags` at class level.
- Do not change the route strings, the `ParseUUIDPipe`, the `@RequiredScope` values, the
  `@SkipThrottle` arguments, or any handler body.
- The `x-required-scope` value on each operation must equal the argument of the
  `@RequiredScope` decorator already on that method.
- Do not add any response status the contract does not declare for that operation.

#### Edge Cases

- **A method has both `@ApiResponse({ status: 200 })` and `@ApiResponse({ status: 201 })`**:
  this is correct and required for the writes — the handler sets 201 on create and 200 on
  replay via `response.status(...)`.
- **`@ApiBody` is not needed**: `@nestjs/swagger` infers the request body class from the
  `@Body() dto: X` parameter's type metadata, and Task 5 decorated those classes. Do not add
  `@ApiBody` unless `typecheck` shows the body is missing from the document, in which case add
  `@ApiBody({ type: CreateReservationDto })` explicitly.
- **Decorator order**: place the Swagger decorators after the existing Nest decorators
  (`@Post`, `@RequiredScope`, `@SkipThrottle`) so the routing and guard metadata reads first.
  Order does not affect behaviour.

#### Verification

```bash
npm run typecheck
npm run lint
npx jest test/unit
```

Expected: all exit 0. The unit suite must be unaffected — no behaviour changed.

#### Completion Criteria

- [ ] All six methods carry `@ApiOperation` with the exact `operationId` from the table.
- [ ] `listReservations` and `getReservation` are tagged `audit`; the other four `capacity`.
- [ ] Each method's `x-required-scope` matches its `@RequiredScope`.
- [ ] The three writes declare exactly nine responses; the three reads exactly five.
- [ ] The three writes declare a required `Idempotency-Key` header, 8–128 characters.
- [ ] No route string, pipe, guard, or handler body changed.

---

### Task 9: Decorate the audit and health controllers

#### Objective

Complete the operation metadata for the remaining three operations.

#### Files

- `src/capacity/api/audit.controller.ts` — modified.
- `src/observability/health.controller.ts` — modified.

#### Implementation

1. `audit.controller.ts`, on the `listLedger` method:
   - `@ApiTags('audit')`
   - `@ApiOperation({ operationId: 'listLedgerEntries', summary: 'Read the append-only ledger behind a program position' })` — note the operationId differs from the method name; the contract declares `listLedgerEntries`.
   - `@ApiExtension('x-required-scope', 'capacity:audit')`
   - `@ApiParam({ name: 'programId', type: String, format: 'uuid', required: true, example: 'b1b2c3d4-0001-4000-8000-000000000011' })`
   - `@ApiHeader({ name: 'x-correlation-id', required: false, schema: { type: 'string', maxLength: 128 } })`
   - Exactly five responses: `200` with `LedgerListResponse`, then `401`, `403`, `404`, `429`
     with `ErrorResponse`, using the same descriptions as Task 8 and the read rate budget.
2. `health.controller.ts`:
   - Add `@ApiTags('health')` at **class** level — both its methods share the tag.
   - On `live`: `@ApiOperation({ operationId: 'live', summary: 'Liveness probe. Reports that the process is running.' })` and `@ApiResponse({ status: 200, description: 'The process is alive.', type: HealthResponse })`.
   - On `ready`: `@ApiOperation({ operationId: 'ready', summary: 'Readiness probe. Reports whether dependencies are reachable.' })`, `@ApiResponse({ status: 200, description: 'Every dependency is reachable.', type: HealthResponse })`, and `@ApiResponse({ status: 503, description: 'At least one dependency is unavailable. The body names which.', type: HealthResponse })`.
   - Do **not** add `@ApiSecurity` or `@ApiBearerAuth` to either method. `ApiSecurity` cannot
     emit an empty array; the empty `security` is applied by
     `withUnauthenticatedHealthOperations` in `src/docs/openapi-document.factory.ts`, which
     already lists `/health/live` and `/health/ready`.
   - Do **not** add `x-required-scope` to either method.

#### Constraints

- `src/observability/` is the `observability` element and may import only `shared` and
  `config`. `HealthResponse` for documentation lives in
  `src/capacity/api/response/health.response.ts`, which is in the `api` element and **cannot be
  imported here**. Therefore: declare a second, local documentation class
  `HealthProbeResponse` inside `src/observability/health.response.ts` (a new file in the
  `observability` element) with the same two properties described in Task 4 item 4, and use it
  here. Delete `src/capacity/api/response/health.response.ts` if Task 4 created it, and remove
  its re-export from `src/capacity/api/response/index.ts`.
- Do not change the `@Public()` decorators, the `@SkipThrottle` argument, or any handler body.
- Do not change the `HealthResponse` **type** already declared in `health.controller.ts`; the
  new class is additional, for documentation only.

#### Edge Cases

- **The boundary violation is real and will be caught**: importing `../capacity/api/response`
  from `src/observability/` is a lint error under the existing matrix. The local class is the
  prescribed resolution. Do not amend `eslint.config.mjs` to permit the import.
- **`@ApiTags` at class level on `HealthController`**: correct here, because both methods share
  the `health` tag — unlike `CapacityController`.

#### Verification

```bash
npm run typecheck
npm run lint
npx jest test/unit test/integration/health.spec.ts
```

Expected: all exit 0. `lint` passing is the proof that no cross-element import was introduced.

#### Completion Criteria

- [ ] `listLedger` carries `operationId: 'listLedgerEntries'`, tag `audit`, scope `capacity:audit`, and exactly five responses.
- [ ] `HealthController` carries class-level `@ApiTags('health')`; `live` declares one response and `ready` two.
- [ ] Neither health method carries `@ApiSecurity`, `@ApiBearerAuth`, or `x-required-scope`.
- [ ] `src/observability/health.response.ts` exists and `src/capacity/api/response/health.response.ts` does not.
- [ ] `npm run lint` passes.

---

### Task 10: Mount the documentation surfaces and wire them into bootstrap

#### Objective

Serve the UI and the raw document when enabled, and register nothing at all when disabled.

#### Files

- `src/docs/docs.bootstrap.ts` — new.
- `src/docs/index.ts` — modified; re-export `mountApiDocs`.
- `src/main.ts` — modified; call it.

#### Implementation

1. `src/docs/docs.bootstrap.ts`:

   ```ts
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
   ```

   The early return is the whole disabled behaviour: when `enabled` is false, **no route is
   registered**, so `/docs` falls through to the global `CapacityErrorFilter` and returns the
   same `404` / `NOT_FOUND` body as any unknown path. The boolean return exists so the caller
   can log the decision and so the unit test can assert it.
2. `src/docs/index.ts` additionally re-exports `mountApiDocs`, `ApiDocsOptions`, `DOCS_PATH`,
   `DOCS_JSON_PATH`, and `DOCS_YAML_PATH`.
3. `src/main.ts` currently reads:

   ```ts
   const app = await NestFactory.create(AppModule, { bufferLogs: true });
   app.useLogger(app.get(Logger));
   app.useGlobalPipes(createValidationPipe());
   app.enableShutdownHooks();
   const configService = app.get(ConfigService);
   const port = configService.get<number>('PORT', 3000);
   await app.listen(port);
   console.log(`Application is running on port ${port}`);
   ```

   Insert the mount between `const port = ...` and `await app.listen(port)`:

   ```ts
   const docsEnabled = configService.get<string>('API_DOCS_ENABLED', 'false') === 'true';
   const mounted = mountApiDocs(app, {
     enabled: docsEnabled,
     port,
     version: process.env.npm_package_version ?? '0.0.0',
   });
   ```

   and extend the existing `console.log` line to also report
   `` `API documentation ${mounted ? `at http://localhost:${port}/docs` : 'disabled'}` ``.
   Import `mountApiDocs` from `./docs`.

   `process.env.npm_package_version` is set by npm when the process is started through an npm
   script, which is how `scripts/dev-stack.sh` starts it (`npm run start:dev`). The `?? '0.0.0'`
   fallback covers a direct `node dist/main` invocation.
4. Add `test/unit/docs-bootstrap.spec.ts` asserting:
   - `mountApiDocs(fakeApp, { enabled: false, port: 4010, version: '0.1.0' })` returns `false`
     and the fake app records **zero** calls of any kind. Use a minimal hand-written object
     cast to `INestApplication` through a single documented `as unknown as` assertion, with an
     inline comment justifying it; do not use `any`.
   - `DOCS_PATH`, `DOCS_JSON_PATH`, and `DOCS_YAML_PATH` are `'docs'`, `'docs/openapi.json'`,
     and `'docs/openapi.yaml'`.

   The enabled path is covered by the integration test in Task 11, which boots a real app.

#### Constraints

- Do not add a controller, a module, or a route handler for the JSON or YAML document.
  `SwaggerModule.setup` serves both through `jsonDocumentUrl` and `yamlDocumentUrl`.
- Do not build the document more than once. `mountApiDocs` builds it exactly once per process.
- Do not mount anything when `enabled` is false — not a stub, not a 404 handler, not a
  redirect.
- Do not import `@nestjs/config` in `src/docs/`; the flag arrives as a plain boolean from
  `main.ts`, which is outside the boundary matrix.
- Do not change the order of `useGlobalPipes` or `enableShutdownHooks` in `main.ts`.

#### Edge Cases

- **`API_DOCS_ENABLED` absent from the environment**: Joi supplies the default, so
  `configService.get` returns `'true'` outside production. The `'false'` fallback in the
  `get` call only applies if the key is missing entirely, which the schema prevents.
- **The string `'TRUE'` or `'1'`**: Joi's `.valid('true','false')` rejects both at boot with a
  validation error. No case-insensitive handling is needed or wanted.
- **`npm_package_version` unset**: the `?? '0.0.0'` fallback applies. The conformance spec does
  not assert a specific version value, only that `info.version` is a non-empty string.
- **`main.ts` is excluded from coverage** (`collectCoverageFrom` excludes it), but
  `src/docs/docs.bootstrap.ts` is **not** — hence the unit test for the disabled path.

#### Verification

```bash
npm run typecheck
npm run lint
npx jest test/unit/docs-bootstrap.spec.ts
```

Expected: all exit 0.

#### Completion Criteria

- [ ] `mountApiDocs` returns `false` and registers nothing when `enabled` is false.
- [ ] `SwaggerModule.setup` is called with `jsonDocumentUrl: 'docs/openapi.json'` and `yamlDocumentUrl: 'docs/openapi.yaml'`.
- [ ] `src/main.ts` calls `mountApiDocs` between reading `port` and `app.listen(port)`.
- [ ] `test/unit/docs-bootstrap.spec.ts` passes.
- [ ] No new controller or route handler was added.

---

### Task 11: Integration-test the served documentation surfaces

#### Objective

Prove the three routes are served when enabled, are absent and indistinguishable from any
unknown path when disabled, and grant no access the API would otherwise refuse.

#### Files

- `test/integration/docs-endpoints.spec.ts` — new.

#### Implementation

Follow the boot pattern in `test/contract/availability.contract.spec.ts`: start the Postgres
and Redis fixtures from `test/support/`, build the testing module from `AppModule`, override
`ThrottlerStorage` with `ThrottlerStorageRedisService` as that file does, apply
`createValidationPipe()`, and `await app.init()`.

Write two `describe` blocks.

**Block 1 — enabled.** Call `mountApiDocs(app, { enabled: true, port: 4010, version: '0.1.0' })`
after `app.init()`. Assert with `supertest`:

1. `GET /docs` → `200`, `content-type` contains `text/html`, body contains `swagger`
   (case-insensitive).
2. `GET /docs/openapi.json` → `200`, `content-type` contains `application/json`, and
   `body.openapi === '3.1.0'`.
3. `GET /docs/openapi.yaml` → `200`, and `content-type` contains `yaml`.
4. Parse the YAML body with `js-yaml`'s `load` and assert it deep-equals the JSON body.
5. `GET /v1/programs/<NORTHWIND_USD_PROGRAM_ID>/availability` with **no** `Authorization`
   header → `401`, proving the mounted docs did not relax the guard chain.
6. The same path with a valid Northwind token → not `401` (it will be `200` or `404` depending
   on seeded state; assert `res.status !== 401` only, so the test does not depend on seeding).
7. A valid Northwind token against `CONTOSO_USD_PROGRAM_ID` → `404`, and the body's `code` is
   `NOT_FOUND`, never `403`.

**Block 2 — disabled.** Boot a second application (or re-init the same module) and call
`mountApiDocs(app, { enabled: false, ... })`. Assert:

1. `GET /docs` → `404`.
2. `GET /docs/openapi.json` → `404`.
3. `GET /nonexistent-path-for-comparison` → `404`.
4. The three response bodies are deep-equal **after removing `correlationId`**, which differs
   per request. This is the non-disclosure assertion: a disabled documentation surface must be
   indistinguishable from any unknown path.
5. `GET /health/live` → `200`, proving the API is unaffected by the flag.

Set `jest.setTimeout(180_000)` as the sibling container specs do. Close both applications and
stop both fixtures in `afterAll`.

#### Constraints

- Do not add `test/integration/docs-endpoints.spec.ts` to `testPathIgnorePatterns`.
- Do not assert on the exact HTML of the Swagger UI page beyond the `swagger` substring; the
  markup is `swagger-ui-dist`'s and may change between patch versions.
- Do not seed data in this spec. Assertion 6 is deliberately `!== 401` so the test does not
  depend on seed state.
- Use the seed constants imported from `scripts/seed.ts`, not hardcoded UUID literals.

#### Edge Cases

- **Docker is unavailable**: the spec fails at fixture start. This is expected and matches every
  other integration spec in the repository; it is why `npm run test:unit` exists separately.
- **`correlationId` differs between the three 404 bodies**: strip the key before the deep-equal
  comparison. Comparing it would make the test fail for the wrong reason.
- **Port 4010 in the metadata**: the mounted document's `servers[0].url` will say 4010 while
  supertest talks to an ephemeral port. That is irrelevant — supertest addresses the HTTP
  server directly and never reads `servers`.

#### Verification

```bash
npx jest test/integration/docs-endpoints.spec.ts
```

Expected: the spec passes, with both blocks green. Requires a running Docker daemon.

#### Completion Criteria

- [ ] All three enabled routes return 200 with the right content types.
- [ ] The YAML and JSON documents parse to deep-equal structures.
- [ ] An unauthenticated API call still returns 401 with the docs mounted.
- [ ] A cross-organisation program returns 404 with code `NOT_FOUND`, never 403.
- [ ] With docs disabled, `/docs`, `/docs/openapi.json`, and an arbitrary unknown path return byte-identical bodies once `correlationId` is removed.
- [ ] `/health/live` returns 200 in both blocks.

---

### Task 12: Write the conformance spec and the document export script

#### Objective

Make drift a build failure. Assert the generated document against the live router in both
directions and against the hand-written 001 contract on every attribute that defines an
operation's identity.

#### Files

- `test/contract/openapi-conformance.contract.spec.ts` — new.
- `scripts/export-openapi.ts` — new.

#### Implementation

**The spec.** Boot the real application under the Postgres and Redis fixtures exactly as Task
11 does. Build the document with `buildOpenApiDocument(app, 4010, '0.1.0')`. Load the oracle:

```ts
import { load } from 'js-yaml';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONTRACT_PATH = join(__dirname, '..', '..', 'specs', '001-program-capacity-reservation', 'contracts', 'http-api.yaml');
const contract = load(readFileSync(CONTRACT_PATH, 'utf8')) as OpenAPIObject;
```

Normalise both documents into a comparable form. The generated document uses Express-style
paths converted by `@nestjs/swagger` into `{param}` form; confirm this during execution by
printing `Object.keys(document.paths)` once, and if any path still contains a `:param`
segment, normalise it with `path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')` before comparing.

Assert:

1. **Router ⊆ document.** Obtain the live route table from the Express adapter:
   `app.getHttpAdapter().getInstance()._router.stack` — filter entries with a `route`, and map
   each to `{ method, path }`. Every such pair must appear in `document.paths`. Exclude paths
   beginning with `/docs`, which are not Nest routes. If the adapter's internals differ on the
   installed Express version and the route table cannot be read, **stop and report** rather than
   dropping this assertion; it is one half of the drift gate.
2. **Document ⊆ router.** Every `{method, path}` in `document.paths` appears in the live route
   table.
3. **Path-and-method sets are equal** between `document.paths` and `contract.paths`.
4. **operationIds match.** For every path and method, `document.paths[p][m].operationId ===
   contract.paths[p][m].operationId`. Assert the full sorted list of operationIds deep-equals
   `['cancelReservation','createRelease','createReservation','getAvailability','getReservation','listLedgerEntries','listReservations','live','ready']`.
5. **Tags match.** For every operation, the document's `tags` array deep-equals the contract's,
   and has length exactly 1.
6. **`x-required-scope` matches.** For every operation the contract declares one, the document
   declares the same value; where the contract declares none (`live`, `ready`), the document
   declares none either.
7. **Response code sets match.** For every operation, `Object.keys(document…responses).sort()`
   deep-equals `Object.keys(contract…responses).sort()`.
8. **Health security.** `document.paths['/health/live'].get.security` and
   `document.paths['/health/ready'].get.security` each deep-equal `[]`.
9. **Every non-health operation inherits document-level security**, i.e. declares no own
   `security` key.
10. **Summaries.** Every operation has a `summary` of at least 20 characters that, lowercased
    and stripped of non-alphanumerics, is not equal to its path lowercased and stripped the same
    way.
11. **Required `Idempotency-Key`.** For each of `createReservation`, `createRelease`,
    `cancelReservation`, the document's `parameters` include one with `in: 'header'`,
    `name: 'Idempotency-Key'`, `required: true`, `schema.minLength === 8`, and
    `schema.maxLength === 128`, and its `description` contains both `IDEMPOTENCY_CONFLICT` and
    `original outcome`.
12. **Error codes.** Import `REFUSAL_STATUS` from `src/capacity/api/error.filter.ts` and
    `REFUSAL_CODES` from `src/capacity/domain/errors.ts`. Serialise the whole document to a
    JSON string and assert every code in `REFUSAL_CODES` appears in it. Assert
    `REFUSAL_STATUS.POSITION_UNVERIFIED === 503` and that every operation whose contract
    response set contains `'503'` documents a `503`.
13. **Non-disclosure.** Every `404` response description contains the word `organisation` or
    `another`, and every `403` response description contains the word `scope`. No `403`
    description contains the word `exist`.
14. **Vendor extensions are not load-bearing.** Deep-clone the document, recursively delete
    every key beginning with `x-`, and assert the result still has the same path-and-method set
    and that every operation still has an `operationId` and a `responses` object.
15. **Metadata.** `document.openapi === '3.1.0'`; `document.info.title` and
    `document.info.version` are non-empty strings; `document.servers[0].url` is a non-empty
    string; `document.security` deep-equals `[{ bearerAuth: [] }]`;
    `document.components.securitySchemes.bearerAuth.scheme === 'bearer'`.
16. **Self-containment.** The serialised document contains no `"$ref": "http` and no
    `"$ref": "./`.

**The export script.** `scripts/export-openapi.ts` boots the application with
`NestFactory.create(AppModule, { logger: false })`, calls
`buildOpenApiDocument(app, Number(process.env.PORT ?? 3000), process.env.npm_package_version ?? '0.0.0')`,
writes `JSON.stringify(document, null, 2)` to the path given as `process.argv[2]` or to stdout
when no argument is given, closes the app, and exits 0. On failure it writes the message to
stderr and sets `process.exitCode = 1`, matching the idiom at the bottom of `scripts/seed.ts`.
It requires a reachable database because `AppModule` connects at init; document that in a
header comment.

#### Constraints

- Do not edit `specs/001-program-capacity-reservation/contracts/http-api.yaml`. If an assertion
  fails because the contract and the code genuinely disagree, **stop and report the
  disagreement** — do not reshape the oracle to match the code, and do not delete the assertion.
- Do not weaken assertions 1 and 2. They are the drift gate.
- Do not use `any`; where the loaded YAML needs a type, cast once to `OpenAPIObject` with an
  inline justification comment.
- Keep the spec under 800 lines. If it approaches that, split assertions 11–16 into
  `test/contract/openapi-operations.contract.spec.ts` with the same boot helper duplicated, not
  a shared mutable fixture.

#### Edge Cases

- **A contract operation has no `x-required-scope`** (`live`, `ready`): assert the document has
  none either, rather than skipping the pair.
- **The generated `404` description wording differs from the contract's**: assertion 13 checks
  for substrings, not equality, precisely so that wording may differ while meaning is pinned.
- **`_router` is `undefined` on newer Express**: Express 5 renames it to `router`. Try
  `getInstance().router ?? getInstance()._router` and, if neither yields a stack, stop and
  report per the Constraints.
- **A route registered by Terminus or the throttler appears in the router but not the
  document**: none is expected. If one appears, report it rather than adding an exclusion list;
  an undocumented route is exactly what this gate exists to find.

#### Verification

```bash
npx jest test/contract/openapi-conformance.contract.spec.ts
npm run typecheck
npm run lint
```

Expected: the spec passes with every assertion green. Requires Docker.

Then prove the gate bites: temporarily add `@Get('temporary-drift-probe')` returning `'x'` to
`AuditController`, re-run the spec, observe assertions 2 and 3 fail, then remove the probe and
re-run to green. Do not commit the probe.

#### Completion Criteria

- [ ] All sixteen assertion groups exist and pass.
- [ ] The nine expected operationIds are asserted as an exact sorted list.
- [ ] `scripts/export-openapi.ts` exists and `npm run openapi:export` writes a document.
- [ ] The drift-probe check was performed and reverted.
- [ ] `specs/001-program-capacity-reservation/contracts/http-api.yaml` is byte-identical to its state before this task.

---

### Task 13: Write the README, its reference check, and the documentation gate script

#### Objective

Give the repository a front door that a new developer can follow literally, and an automated
check that keeps every command, path, and variable it names true.

#### Files

- `README.md` — new, at the repository root.
- `test/unit/readme-references.spec.ts` — new.
- `scripts/verify-docs.sh` — new, executable.

#### Implementation

**`README.md`** with these sections, in this order:

1. **Title and purpose.** What the service does: a capacity and invoice reservation ledger for
   financing programs, deriving each program's position from an append-only ledger and
   reconciling it against an external treasury system over a message stream. Two paragraphs, no
   jargon beyond the domain's own.
2. **Prerequisites.** Node.js `>=22.0.0 <23`; a running Docker daemon.
3. **Running it.** `./scripts/dev-stack.sh` brings up Postgres, Redis, and Redpanda, runs
   migrations, seeds, and starts the API. State that ports are allocated per worktree and that
   `./scripts/dev-stack.sh env` prints the resolved set, and that 5432, 6379, and 9092 must
   never be assumed. List the subcommands `up`, `down`, `reap`, `env`.
4. **First call.** Show capturing the resolved environment with
   `eval "$(./scripts/dev-stack.sh env | sed 's/^/export /')"`, note that `npm run seed` prints
   one credential per organisation to stdout, name the seeded program constant
   `NORTHWIND_USD_PROGRAM_ID` and its value, and give a complete `curl` against
   `/v1/programs/{programId}/availability` using `$TOKEN` and `$PORT`. Include **no token
   literal**.
5. **API documentation.** Link `/docs`, `/docs/openapi.json`, `/docs/openapi.yaml`. State that
   `API_DOCS_ENABLED` controls exposure, defaults to enabled outside production and disabled in
   production, and that when disabled the paths are not registered at all.
6. **Testing.** `npm run test:unit` (no Docker), `npm test` (integration, needs Docker),
   `npm run test:cov` (80% global threshold), `npm run test:recovery`, `npm run test:perf`,
   `npm run docs:verify`.
7. **Architecture.** The elements under `src/`: `capacity/domain`, `capacity/application`,
   `capacity/infrastructure`, `capacity/api`, plus `shared`, `auth`, `config`, `observability`,
   `treasury`, `fx`, `docs`. State that cross-element dependencies are enforced by
   `eslint-plugin-boundaries` in `eslint.config.mjs` and that a violation is a lint error.
8. **Configuration.** Environment-supplied, validated at boot by Joi in
   `src/config/env.schema.ts`; boot fails naming any missing variable. Point at `.env.example`
   for local values and state explicitly that its values are local development only.
9. **Further reading.** Relative links to `.specify/memory/constitution.md`,
   `docs/ASSUMPTIONS.md`, `docs/kafka-acls.md`, `docs/plans/`, and `specs/`.

**`test/unit/readme-references.spec.ts`** — Docker-free. Read `README.md` once, then assert:

1. **npm scripts.** For every match of `/npm run ([a-z][a-z0-9:-]*)/g`, the captured name is a
   key of `package.json`'s `scripts`.
2. **Shell scripts.** For every match of `/(?:\.\/)?scripts\/([a-z0-9-]+\.(?:sh|ts))/g`, the
   file exists.
3. **Source and doc paths.** For every match of
   `/`([a-zA-Z0-9_./-]+\.(?:ts|md|mjs|json|yaml|yml|example))`/g` inside backticks, if the
   captured string contains a `/` and does not start with `http`, the path exists relative to
   the repository root. Exempt paths beginning with `dist/` or `node_modules/`.
4. **Environment variables.** For every match of `/\b([A-Z][A-Z0-9_]{2,})\b/g`, if the token is
   not in an allow-list of non-variable capitals (`API`, `HTTP`, `JSON`, `YAML`, `URL`, `UUID`,
   `SQL`, `TODO`, `README`, `MIT`, `ISO`, `JWT`, `SASL`, `TLS`, `CI`), assert it is a key in
   `src/config/env.schema.ts` — matched with `/^\s*([A-Z][A-Z0-9_]*)\s*:/gm` as
   `scripts/verify-uat.sh` does.
5. **Relative links.** For every match of `/\]\((?!https?:)([^)#]+)/g`, the target exists
   relative to the repository root, allowing a trailing `/` for directories.
6. **No secrets.** The README contains none of: `capacity_local_dev`,
   `local_dev_jwt_secret_change_me_0123456789`, the substring `eyJ` (a JWT prefix), or a
   `postgres://` URL containing an `@`.

   Assert each of the six groups with a message naming the offending token, so a failure is
   self-explaining.

**`scripts/verify-docs.sh`** — `#!/usr/bin/env bash`, `set -uo pipefail`, `cd "$(dirname "$0")/.."`,
and the `fail()` / `ok()` helper pair copied from `scripts/verify-uat.sh`'s idiom. It runs, in
order:

1. `npm --silent run typecheck` → fail `"tsc --noEmit exited non-zero"`.
2. `npx jest test/unit/readme-references.spec.ts test/unit/openapi-schemas.spec.ts test/unit/openapi-metadata.spec.ts test/unit/docs-bootstrap.spec.ts` → fail `"documentation unit specs failed"`.
3. `[ -f README.md ]` → fail `"README.md is missing"`.
4. A node one-liner asserting `package.json` `scripts` contains `docs:verify` and
   `openapi:export`.
5. A node one-liner asserting `.env.example` and `src/config/env.schema.ts` both contain
   `API_DOCS_ENABLED`.

   Then print a final line naming what it does **not** assert — the conformance spec, because it
   requires Docker — mirroring `verify-uat.sh`'s closing section. Exit 0 with
   `printf 'verify-docs: PASS\n'`.

   `chmod +x scripts/verify-docs.sh`.

#### Constraints

- Do not modify `scripts/verify-uat.sh`.
- Do not put any credential, token, or password in `README.md`.
- Do not reference a command, path, or variable in the README that does not exist — the spec
  will fail, and that is the point.
- The reference spec must parse the README generically. Do not hardcode a list of the specific
  scripts or paths the README happens to mention today.

#### Edge Cases

- **A capitalised word that is not an environment variable**, such as `POST` or `GET`: extend
  the allow-list in the spec rather than weakening the regex. Add `GET`, `POST`, `PATCH`,
  `PUT`, `DELETE`, `NOT`, `AND`, `OR`.
- **A path inside a fenced code block that is illustrative rather than real**, such as
  `src/<feature>/`: the backtick rule matches only concrete extensions
  (`.ts`, `.md`, `.mjs`, `.json`, `.yaml`, `.yml`, `.example`), so a directory placeholder does
  not match. Do not add directory matching.
- **`.env.example` referenced in the README**: it exists, so the path rule passes.
- **A link to a directory such as `docs/plans/`**: the link rule allows a trailing slash and
  checks directory existence.

#### Verification

```bash
npm run typecheck
npm run lint
npx jest test/unit/readme-references.spec.ts
./scripts/verify-docs.sh
```

Expected:

- The spec passes with six assertion groups green.
- `verify-docs.sh` prints `verify-docs: PASS` and exits 0.

Then prove the gate bites: temporarily add the line `` Run `npm run nonexistent-script`. `` to
the README, re-run the spec, observe it fail naming `nonexistent-script`, then remove the line
and re-run to green. Do not commit the temporary line.

#### Completion Criteria

- [ ] `README.md` exists with all nine sections.
- [ ] It contains no credential, token, or `postgres://` URL with an `@`.
- [ ] `test/unit/readme-references.spec.ts` passes and is Docker-free.
- [ ] `scripts/verify-docs.sh` is executable and `npm run docs:verify` exits 0.
- [ ] The deliberate-failure check was performed and reverted.
- [ ] `scripts/verify-uat.sh` is unchanged and still passes.

---

### Task 14: Record the decisions in ASSUMPTIONS.md

#### Objective

Discharge the constitution's requirement that every assumption, trade-off, and deviation be
recorded with its rationale — specifically the two unauthenticated routes, which Principle V
requires be justified per route.

#### Files

- `docs/ASSUMPTIONS.md` — modified; append entries.

#### Implementation

Read `docs/ASSUMPTIONS.md` first and match its existing heading level, numbering, and entry
format exactly. Append entries covering:

1. **Two unauthenticated routes (Constitution Principle V).** `/docs` and the raw document at
   `/docs/openapi.json` and `/docs/openapi.yaml` require no credential. Justification: they
   publish the API's contract — schemas and seeded example identifiers — and contain no
   organisation, program, invoice, or ledger data. Controls: exposure is gated by
   `API_DOCS_ENABLED`, which defaults to disabled when `NODE_ENV === 'production'`; when
   disabled nothing is mounted, so a request is answered by the global catch-all filter with the
   same `404` / `NOT_FOUND` body as any unknown path and discloses nothing. Requests issued from
   the page traverse the identical guard chain, validation pipe, and per-organisation rate
   limiter, verified by `test/integration/docs-endpoints.spec.ts`.
2. **The document is generated, not hand-written.** Rationale: Principle VII requires
   documentation to track the running service; a hand-maintained file drifts by default.
   `test/contract/openapi-conformance.contract.spec.ts` asserts the generated document against
   both the live router and `specs/001-program-capacity-reservation/contracts/http-api.yaml`.
3. **The 001 contract is retained as the oracle, not replaced.** It remains the design
   statement and the response-schema source for the existing contract suite; the generated
   document is what is served. Neither is hand-synchronised with the other.
4. **The `@nestjs/swagger` CLI plugin is not enabled.** Rationale: it infers schemas from
   TypeScript types, which would type money without a pattern, and it does not run under
   `ts-node` or `ts-jest`, so a document built in a test would differ from one built by
   `nest build`. Explicit `@ApiProperty` decorators are used instead; the cost is verbosity.
5. **Schema-level unit tests build their document from a minimal empty module with
   `extraModels`,** so they stay Docker-free; router-level assertions require the real
   application and therefore live in the contract suite and require Docker.
6. **`STATUS` in `src/capacity/api/error.filter.ts` was exported as `REFUSAL_STATUS`, and
   `REFUSAL_CODES` was added to `src/capacity/domain/errors.ts`,** solely so the documented
   error contract can be asserted against the mapping the service applies. No behaviour changed.
7. **The health documentation class is duplicated** as `src/observability/health.response.ts`
   rather than imported from `src/capacity/api/response/`, because the `observability` element
   may not import `api`. The duplication is deliberate and preserves the boundary.

#### Constraints

- Do not restructure or reword existing entries in `docs/ASSUMPTIONS.md`.
- Do not record an assumption the implementation did not actually make.

#### Edge Cases

- **The file uses numbered entries**: continue the numbering from the last existing entry rather
  than restarting.

#### Verification

```bash
npx jest test/unit/readme-references.spec.ts
./scripts/verify-docs.sh
./scripts/verify-uat.sh
```

Expected: all exit 0. `verify-uat.sh` section 15 asserts `docs/ASSUMPTIONS.md` exists and must
still pass.

#### Completion Criteria

- [ ] Seven entries are appended, matching the file's existing format.
- [ ] The Principle V justification names the flag, the production default, and the
      not-mounted-when-disabled behaviour.
- [ ] `./scripts/verify-uat.sh` still prints `PASS`.

---

## Final Verification

Run in this order from the repository root, with a Docker daemon running.

1. Static gates.
2. The full test suite, including the container-backed conformance and integration specs.
3. Coverage against the 80% global threshold.
4. Both documentation gates and the untouched phase gate.
5. The manual browser and API-client checks, which no automated test can replace.

Commands:

```bash
npm run typecheck
npm run lint
npm run test:unit
npm test
npm run test:cov
npm run docs:verify
./scripts/verify-uat.sh
```

Expected:

- `typecheck`, `lint` exit 0.
- `test:unit` passes, including `openapi-metadata`, `openapi-schemas`, `docs-bootstrap`,
  `response-mirrors`, `refusal-status`, and `readme-references`.
- `npm test` passes, including `openapi-conformance.contract.spec.ts` and
  `docs-endpoints.spec.ts`.
- `test:cov` reports branches, functions, lines, and statements all at or above 80 with
  `src/docs/**` included.
- `docs:verify` prints `verify-docs: PASS`.
- `verify-uat.sh` prints `verify-uat: PASS`, unchanged from before this work.

Manual sequence:

```bash
eval "$(./scripts/dev-stack.sh env | sed 's/^/export /')"
./scripts/dev-stack.sh
```

Then, in another shell:

1. Open `http://localhost:$PORT/docs`. Confirm nine operations appear under exactly three
   groups — `capacity`, `audit`, `health` — that each has a business-language summary, that the
   three write operations show `Idempotency-Key` as required, and that no monetary field renders
   as a number.
2. `curl -s "http://localhost:$PORT/docs/openapi.json" -o /tmp/openapi.json`. Import
   `/tmp/openapi.json` into two mainstream API clients. Confirm zero import errors, that every
   operation appears as a runnable request, that setting the bearer token once at collection
   level authorises all of them, and that `getAvailability` executes successfully against the
   seeded instance with no hand-editing.
3. Restart with `API_DOCS_ENABLED=false ./scripts/dev-stack.sh`. Confirm
   `curl -s "http://localhost:$PORT/docs"` and
   `curl -s "http://localhost:$PORT/no-such-path"` return bodies identical except for
   `correlationId`, and that an authenticated API call still succeeds.
4. On a clean clone, follow `README.md` literally with no other source of information until a
   first API call returns a success response. It must take under 15 minutes and require no
   questions.

## Executor Rules

1. Execute each task in a **separate sub-agent** with a fresh context; do not run multiple tasks
   inside one long-lived session.
2. Execute tasks strictly in numerical order.
3. Complete the current task and its verification before starting the next task.
4. Implement the solution described in the plan exactly.
5. Do not redesign architecture or substitute a different approach.
6. Do not add features, cleanup, abstractions, or refactors not explicitly required by the plan.
7. Do not omit planned behaviour because another implementation appears simpler.
8. Do not reinterpret product requirements.
9. Do not make optional improvements.
10. Follow existing project conventions where the plan explicitly relies on them.
11. Run the verification specified for every task.
12. Mark a task complete only when its completion criteria are satisfied.
13. If implementation reveals information that does not affect the prescribed solution, continue
    execution.
14. Stop rather than improvise when the plan cannot be executed as written.

The executor may stop only for a concrete blocker such as:

- a referenced file, API, dependency, or subsystem does not exist;
- repository state materially contradicts facts the plan depends on;
- a required credential or external resource is unavailable;
- the prescribed implementation is technically impossible;
- executing the plan would require making an architectural or product decision not covered by
  the plan;
- two instructions in the plan directly contradict each other;
- verification proves that an assumption fundamental to the planned implementation is false.

When stopping, the executor must report:

- the task number;
- the exact blocker;
- the evidence establishing the blocker;
- which plan assumption is invalid;
- the minimum planning decision required to continue.

The executor must **not** propose or implement an alternative unless explicitly asked to
re-plan.

**One project-specific stopping rule takes precedence over the urge to make a test green:** if
Task 12's conformance spec fails because the generated document and
`specs/001-program-capacity-reservation/contracts/http-api.yaml` genuinely disagree about an
operation, that is a real finding about this codebase. Stop and report it. Do not edit the
contract to match the code, and do not delete or weaken the assertion.
