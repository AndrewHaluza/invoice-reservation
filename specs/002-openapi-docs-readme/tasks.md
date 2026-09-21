---

description: "Task list for 002-openapi-docs-readme"
---

# Tasks: API Documentation & Project README

**Input**: Design documents from `/specs/002-openapi-docs-readme/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: **Included and mandatory.** Constitution Principle VI ("Test-First with Concurrency
and Failure Coverage") is NON-NEGOTIABLE: failing test → minimal implementation → refactor,
80% global coverage, merging on a red suite is forbidden. Every test task below must be
written and observed FAILING before the implementation tasks it guards.

**Organization**: Grouped by user story so each is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1 / US2 / US3 — maps to the user stories in spec.md
- Exact file paths are given in every task

## Path Conventions

Single NestJS project at the repository root: `src/` and `test/{unit,contract,integration}/`,
per the Structure Decision in plan.md.

**Ports are per-worktree.** Never hardcode 3000/5432/6379/9092 in any task's code or test.
Resolve with `./scripts/dev-stack.sh env`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Dependencies, configuration, and the boundary declaration that later phases need.

- [x] T001 Add `@nestjs/swagger` at the `^11` major line to `dependencies` in `package.json` and run `npm install`; confirm the resolved version's peer range matches the installed NestJS 11 packages and that `package-lock.json` is updated
- [x] T002 Declare the new `docs` boundary element in `eslint.config.mjs`: add `{ type: 'docs', pattern: 'src/docs/**' }` to `boundaries/elements`, and add a policy allowing `docs` to import ONLY `shared` and `config` (no `domain`, `application`, `infrastructure`, `api`, `treasury`, `auth`, `fx`, `observability`), per research.md R-006
- [x] T003 [P] Add `API_DOCS_ENABLED` to `src/config/env.schema.ts` as `Joi.string().valid('true','false')` defaulting to `'false'` when `NODE_ENV === 'production'` and `'true'` otherwise, per contracts/docs-endpoints.md
- [x] T004 [P] Add `API_DOCS_ENABLED=true` to `.env.example` — `scripts/verify-uat.sh` section 6 asserts `.env.example` declares EXACTLY the keys `env.schema.ts` requires, so both files must change together or UAT fails
- [x] T005 [P] Add npm scripts to `package.json`: `"docs:verify": "./scripts/verify-docs.sh"` and `"openapi:export": "ts-node scripts/export-openapi.ts"`
- [x] T006 Create the directory `src/docs/` with an `index.ts` that re-exports the element's public surface (populated in Phase 2), so the boundary declared in T002 resolves against a real element

**Checkpoint**: `npm run lint` and `npm run typecheck` pass; `scripts/verify-uat.sh` section 6 still passes.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The OpenAPI document itself. Both US1 (page) and US2 (export) are presentations
of this one artefact, so it must exist and be correct before either can be delivered.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Tests for Foundational (write FIRST, observe FAILING) ⚠️

- [x] T007 [P] Write `test/unit/openapi-metadata.spec.ts` asserting document-level contract items A1, A4, A5, A6, A7 from contracts/openapi-document.md: `openapi === '3.1.0'`; `info.title === 'Program Capacity & Invoice Reservation API'`; `info.version` equals `package.json` `version`; `info.description` is non-empty; `servers[0].url` is present; `components.securitySchemes.bearerAuth` is `{ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }`; `tags` is exactly `capacity`, `audit`, `health`. Test the metadata object directly (no app boot) so this stays Docker-free
- [x] T008 [P] Write `test/unit/openapi-money-typing.spec.ts` asserting contract items C1–C4: walk EVERY schema in `components.schemas` recursively and fail on any property whose name matches `/amount|minor|limit|reserved|available|balance/i` typed as `number` or `integer`; assert every monetary object `required`s both `amountMinor` and `currency`; assert `amountMinor` is `type: string` with an integer `pattern` and a STRING example; assert `currency` is `type: string` with pattern `^[A-Z]{3}$`. Walk generically, never a curated field list, so a monetary field on a future DTO is caught without editing this test
- [ ] T009 [P] Write `test/unit/openapi-error-codes.spec.ts` asserting contract items D1–D3 and D6: import the `MESSAGES` and `STATUS` maps from `src/capacity/api/error.filter.ts` and assert the documented error-code set equals the filter's refusal-code set exactly, that each code's documented status equals `STATUS[code]`, and that `POSITION_UNVERIFIED` maps to `503`

### Implementation for Foundational

- [x] T010 [P] Create `src/docs/openapi-metadata.ts` exporting a `buildDocumentConfig(port: number)` that returns a `DocumentBuilder` configured per data-model.md §1: `.setOpenAPIVersion('3.1.0')`, title, version read from `package.json`, a description stating the service's purpose AND that a program outside the caller's scope resolves to `404` never `403`, `.addServer('http://localhost:${port}')`, `.addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearerAuth')`, and the three tags `capacity`, `audit`, `health` (satisfies T007)
- [x] T011 [P] Create `src/capacity/api/response/money.response.ts` declaring `MoneyResponse` and `PositiveMoneyResponse` exactly per data-model.md §3: `amountMinor` as `@ApiProperty({ type: String, pattern: '^[0-9]+$', example: '150000' })` with a description stating it is an integer in minor units and a string because values exceed exact float range; `currency` as `@ApiProperty({ type: String, pattern: '^[A-Z]{3}$', example: 'USD' })`. `PositiveMoneyResponse` narrows the pattern to `^[1-9][0-9]{0,18}$`
- [x] T012 [P] Create `src/capacity/api/response/error.response.ts` declaring `ErrorResponse` per data-model.md §4: required `code` (string, machine-readable — clients branch on this, never on `message`), required `message` (string, fixed prose that never interpolates an amount, identifier, or program id), optional `details` (object, additionalProperties, at most 20 entries)
- [x] T013 [P] Create `src/capacity/api/response/page.response.ts` declaring the pagination envelope per data-model.md §7: `items` array and `nextCursor` as nullable string documented as OPAQUE — passed back verbatim, never parsed or constructed by a client
- [x] T014 [P] Create `src/capacity/api/response/availability.response.ts` declaring `AvailabilityResponse` mirroring `AvailabilityBody` from `src/capacity/application/availability.projection.ts`, all monetary fields typed `MoneyResponse`, including the `treasury.lagSeconds` field
- [x] T015 [P] Create `src/capacity/api/response/reservation.response.ts` declaring `ReservationResponse` mirroring `ReservationBody` from `src/capacity/application/reservation.projection.ts`, plus `ReserveResponse`, `ReleaseResponse`, and `CancelResponse` mirroring `ReserveBody`, `ReleaseBody`, and `CancelBody`
- [x] T016 [P] Create `src/capacity/api/response/ledger-entry.response.ts` declaring `LedgerEntryResponse` mirroring the audit read row returned by `src/capacity/application/audit-read.service.ts`
- [x] T017 Add a compile-time assertion to each response class file from T014–T016 asserting the class is assignable to the application body type it mirrors (e.g. `const _assert: AvailabilityBody = {} as AvailabilityResponse;` or an equivalent `satisfies`/conditional-type check), so a field added to a body type without a matching field on the response class is a BUILD failure, not a documentation lie — per plan.md Structure Decision (depends on T014, T015, T016)
- [x] T018 [P] Decorate `src/capacity/api/dto/create-reservation.dto.ts` with `@ApiProperty` per data-model.md §5: `invoiceId` string, 1–128 characters; `amount` as `PositiveMoneyResponse`. Do NOT enable the `@nestjs/swagger` CLI plugin (research.md R-002)
- [x] T019 [P] Decorate `src/capacity/api/dto/create-release.dto.ts` with `@ApiProperty`: `amount` as `PositiveMoneyResponse`
- [x] T020 [P] Decorate `src/capacity/api/dto/cancellation.dto.ts` with `@ApiProperty`: `reason` as an enum of exactly `CANCELLED` and `WRITTEN_OFF`; `note` as `@ApiPropertyOptional` string with maxLength 512
- [x] T021 [P] Decorate `src/capacity/api/dto/list-reservations.query.ts` with `@ApiPropertyOptional` per data-model.md §7: `status` enum of exactly `ACTIVE`, `PARTIALLY_RELEASED`, `FULLY_RELEASED`, `CANCELLED`, `WRITTEN_OFF`; `cursor` opaque string; `limit` integer with minimum 1 and maximum 200
- [x] T022 Create `src/docs/openapi-document.factory.ts` exporting `buildOpenApiDocument(app: INestApplication, port: number): OpenAPIObject` that calls `SwaggerModule.createDocument` with the config from T010. The result must be self-contained — no external or file `$ref` (contract item A3). Export it from `src/docs/index.ts` (depends on T006, T010)
- [ ] T023 Run `test/unit/openapi-metadata.spec.ts`, `test/unit/openapi-money-typing.spec.ts`, and `test/unit/openapi-error-codes.spec.ts` against the document produced by `src/docs/openapi-document.factory.ts` and make all three pass. If T008 fails on any inherited or nested schema, fix the DECORATOR, never the test's traversal
- [x] T024 Verify `npm run lint` passes with the `docs` boundary policy from T002 in force — `src/docs/` must not have acquired an import of `domain`, `application`, `infrastructure`, or `api`

**Checkpoint**: The document exists in memory, carries correct metadata, types no money as a
number, and documents exactly the error codes the filter can raise. Neither user story has
started.

---

## Phase 3: User Story 1 — Browse the API in an interactive reference (Priority: P1) 🎯 MVP

**Goal**: An integrator opens a page in a browser and learns the entire API — every operation,
its permission, its body, its responses — without reading source code or asking anyone.

**Independent Test**: Start the service, open the documentation page, and confirm a reader who
has never seen the codebase can name every operation, its required permission, its request
body fields, and its success and failure responses, using only that page.

### Tests for User Story 1 (write FIRST, observe FAILING) ⚠️

- [x] T025 [P] [US1] Write `test/contract/openapi-conformance.contract.spec.ts` covering contract items B1–B8: boot the real app under the existing `test/support/postgres-container.ts` and `test/support/redis-container.ts` fixtures (research.md R-003 — do NOT mock the graph), build the document, and assert (B1) every path-and-method the live router serves appears in the document, (B2) every documented path-and-method is served by the router, (B3) the document's path-and-method set equals that of `specs/001-program-capacity-reservation/contracts/http-api.yaml`, (B4) `operationId`s match one for one, (B5) each operation's `x-required-scope` matches, (B6) each operation's response status set matches, (B7) every operation has a non-empty `summary` that is not merely its path re-spelled, (B8) every operation has exactly one tag. Load the YAML oracle with `js-yaml`, reusing the pattern in `test/support/openapi.ts`
- [x] T026 [P] [US1] Extend the conformance spec (or add `test/contract/openapi-operations.contract.spec.ts`) with contract items D4, D5, D7, E1–E5, F1–F4, G1–G3, H1–H3: every non-health operation documents `401`/`403`/`404`/`429`; each write documents `409` with its raisable refusal codes; the `404` description states an out-of-scope program is indistinguishable from a missing one while `403` is described as a scope failure only; all three writes declare `Idempotency-Key` as a REQUIRED header constrained to 8–128 characters with both replay outcomes described; `createReservation` documents both `201` and `200`; the two paginated operations document `limit` (1–200) and an opaque `cursor` plus `items`/`nextCursor`; the document states both per-organisation rate budgets and their defaults; both health operations carry `security: []` and no `x-required-scope`
- [x] T027 [P] [US1] Write `test/integration/docs-endpoints.spec.ts` asserting the page is served: `GET /docs` returns `200` with `text/html` when `API_DOCS_ENABLED=true`

### Implementation for User Story 1

- [x] T028 [P] [US1] Add `@ApiTags`, `@ApiOperation` (business-language `summary` + `operationId`), and `@ApiResponse` decorators to `src/capacity/api/capacity.controller.ts` for all six operations, using the exact `operationId`s in data-model.md §2 (`createReservation`, `createRelease`, `cancelReservation`, `getAvailability`, `listReservations`, `getReservation`) and the response classes from T014–T016
- [x] T029 [P] [US1] Add the same decorators to `src/capacity/api/audit.controller.ts` for `getLedger` under the `audit` tag
- [x] T030 [P] [US1] Add `@ApiTags('health')` and `@ApiExcludeEndpoint`-free operation decorators to `src/observability/health.controller.ts` for `getLiveness` and `getReadiness`, each declaring `security: []` via `@ApiSecurity` override or `@ApiExcludeSecurity` equivalent so they are documented as requiring NO credential (contract items H1–H3)
- [x] T031 [US1] Add `@ApiHeader` for `Idempotency-Key` to the three write operations in `src/capacity/api/capacity.controller.ts`, marked `required: true`, described as 8–128 characters, stating that a replay with identical content returns the original outcome and a replay with differing content is refused `409 IDEMPOTENCY_CONFLICT` (contract items E1–E4) (depends on T028)
- [x] T032 [P] [US1] Add `@ApiHeader` for the optional `X-Correlation-Id` to all operations in both capacity and audit controllers, described as echoed and propagated to logs (data-model.md §6)
- [x] T033 [US1] Add `@ApiExtension('x-required-scope', ...)` to every non-health operation in `src/capacity/api/capacity.controller.ts` and `src/capacity/api/audit.controller.ts`, matching the value on each operation's existing `@RequiredScope` decorator, so the conformance oracle in `test/contract/openapi-conformance.contract.spec.ts` has something to compare (depends on T028, T029)
- [x] T034 [US1] Create `src/docs/docs.bootstrap.ts` exporting `mountApiDocs(app, { enabled, port })` which, when `enabled` is false, mounts NOTHING — returns without registering any route, per contracts/docs-endpoints.md. When true, it calls `SwaggerModule.setup('docs', app, document)` to serve the interactive page. Export from `src/docs/index.ts` (depends on T022)
- [x] T035 [US1] Wire `mountApiDocs` into `src/main.ts`, reading `API_DOCS_ENABLED` and `PORT` from `ConfigService` after `app.useGlobalPipes(...)` and before `app.listen(port)`. Build the document ONCE here and cache it — never per request (contracts/docs-endpoints.md, Performance) (depends on T034)
- [x] T036 [US1] Make T025, T026, and T027 pass. Where B3–B6 fail because the generated document and `specs/001-.../contracts/http-api.yaml` genuinely disagree, investigate BOTH: a real drift between the contract and the code is a finding to be raised, not silenced by editing the oracle to match whatever the code happens to do

**Checkpoint**: The page is live and complete. An integrator can learn the whole API from it.
This is the MVP — shippable on its own.

---

## Phase 4: User Story 2 — Import the API into an API client (Priority: P2)

**Goal**: A single machine-readable file that imports cleanly into mainstream API clients and
produces runnable, pre-filled requests.

**Independent Test**: Fetch the description from a running instance, import it into at least
two different API clients, and confirm each produces an executable request per operation that
succeeds against a seeded instance once a credential is supplied.

### Tests for User Story 2 (write FIRST, observe FAILING) ⚠️

- [x] T037 [P] [US2] Extend `test/integration/docs-endpoints.spec.ts` with contract item A8 and the route table in contracts/docs-endpoints.md: `GET /docs/openapi.json` returns `200` with `application/json`; `GET /docs/openapi.yaml` returns `200` with `application/yaml`; parsing the YAML body yields a structure DEEPLY EQUAL to the JSON body
- [ ] T038 [P] [US2] Write `test/contract/openapi-validity.contract.spec.ts` covering contract items A2, A3, J1–J3: the document validates against the OpenAPI 3.1 meta-schema with zero errors using the repository's existing `Ajv2020` + `ajv-formats` setup; no `$ref` targets an external file or URL; every `operationId` is unique; `bearerAuth` is declared at document level so a client sets the credential once; and stripping every `x-` prefixed key still leaves a valid, complete document (J3 — `x-required-scope` must not be load-bearing for clients that ignore extensions)
- [ ] T039 [P] [US2] Write `test/contract/openapi-examples.contract.spec.ts` covering contract items I1–I4: every operation carries at least one response example and, where it takes a body, one request example; EVERY example program id and organisation id appears in `scripts/seed.ts` (import the exported constants rather than hardcoding); every example monetary amount is a string of digits; every example `Idempotency-Key` satisfies the 8–128 character constraint

### Implementation for User Story 2

- [x] T040 [US2] Extend `src/docs/docs.bootstrap.ts` to serve `GET /docs/openapi.json` and `GET /docs/openapi.yaml` from the same cached document built in T035, serialising YAML with the already-present `js-yaml` (move it from `devDependencies` to `dependencies` in `package.json` if it is used at runtime — and update `.env.example`-independent lockfile accordingly) (depends on T034)
- [ ] T041 [P] [US2] Add `@ApiProperty({ example: ... })` request examples to the three write DTOs, drawing every program and organisation identifier from the exported constants in `scripts/seed.ts` (`NORTHWIND_USD_PROGRAM_ID` etc.), with monetary amounts as digit strings and a valid 8–128 character `Idempotency-Key` example (contract items I1–I4)
- [x] T042 [P] [US2] Add `@ApiProperty({ example: ... })` response examples to `src/capacity/api/response/availability.response.ts`, `reservation.response.ts`, and `ledger-entry.response.ts`, using the same seeded identifiers exported from `scripts/seed.ts`, so every operation has both a request and a response example
- [x] T043 [P] [US2] Create `scripts/export-openapi.ts` writing the document to a path given as an argument (default stdout), for readers who want the file without a running instance; wire to the `openapi:export` npm script added in T005
- [ ] T044 [US2] Make `test/integration/docs-endpoints.spec.ts`, `test/contract/openapi-validity.contract.spec.ts`, and `test/contract/openapi-examples.contract.spec.ts` pass. If J3 fails, the fix is to remove the extension's load-bearing role, never to drop the assertion
- [ ] T045 [US2] Manually execute quickstart.md Scenario 3: import the exported document into two mainstream API clients, confirm zero import errors, confirm each operation appears as a runnable request, confirm setting the bearer token ONCE at collection level authorises all of them, and confirm `getAvailability` and `createReservation` execute successfully against a seeded instance with NO hand-editing of any request (SC-003)

**Checkpoint**: US1 and US2 both work. The API is browsable and importable.

---

## Phase 5: User Story 3 — Get the service running from a clean clone (Priority: P3)

**Goal**: A README that takes a new developer from `git clone` to a successful API call without
asking anyone a question — and an automated check that keeps it true.

**Independent Test**: On a machine with only the stated prerequisites, clone the repository
fresh and follow the README literally, with no other source of information, until a first API
call returns success and the test suite runs.

### Tests for User Story 3 (write FIRST, observe FAILING) ⚠️

- [x] T046 [P] [US3] Write `test/unit/readme-references.spec.ts` (Docker-free) asserting FR-030 and FR-033: parse `README.md` and assert every `npm run <script>` it mentions exists in `package.json` `scripts`; every repository path it names exists on disk; every `UPPER_SNAKE_CASE` token matching an environment-variable shape exists as a key in `src/config/env.schema.ts`; every relative markdown link resolves to an existing file. Parse generically — never a curated allow-list — so the check holds as the README grows
- [x] T047 [P] [US3] Extend `test/unit/readme-references.spec.ts` with FR-029: assert the README contains no secret value — no JWT, no password literal, no connection string carrying credentials; scan for the local-dev credential strings that appear in `scripts/dev-stack.sh` and `docker/postgres-init.sql` and fail if any is reproduced in the README

### Implementation for User Story 3

- [x] T048 [US3] Create `README.md` at the repository root with the purpose section (FR-021): what the service does and the business problem it solves — program capacity and invoice reservation as an append-only ledger reconciled against an external treasury system — in terms a reader outside the team can follow
- [x] T049 [US3] Add the prerequisites and startup section (FR-022): Node.js `>=22.0.0 <23`, a running Docker daemon, and `./scripts/dev-stack.sh` as the single command that brings up infrastructure, migrations, seed, and API. State explicitly that ports are allocated per worktree and that `./scripts/dev-stack.sh env` prints the resolved set — never hardcode 5432/6379/9092
- [x] T050 [US3] Add the first-call walkthrough (FR-023): how to capture a credential and sample program id from the seed output, and a complete `curl` example against `GET /v1/programs/{programId}/availability` that returns `200`. Reference identifiers by name from `scripts/seed.ts`; include no token literal (depends on T048)
- [ ] T051 [US3] Add the API documentation section (FR-024) linking `/docs`, `/docs/openapi.json`, and `/docs/openapi.yaml`, and stating that `API_DOCS_ENABLED` controls exposure and defaults to off in production (depends on T035, T040)
- [x] T052 [US3] Add the testing section (FR-025): `npm run test:unit` (Docker-free), `npm test` (integration, requires Docker), `npm run test:cov` (80% global threshold), `npm run test:recovery`, `npm run test:perf`, and `npm run docs:verify`
- [x] T053 [US3] Add the architecture section (FR-026): the layered structure under `src/capacity/{domain,application,infrastructure,api}` plus `shared`, `auth`, `config`, `observability`, `treasury`, `fx`, and the statement that cross-layer dependencies are enforced by `eslint-plugin-boundaries` in `eslint.config.mjs` — a violation is a lint error, not a preference
- [x] T054 [US3] Add the configuration section (FR-027): configuration comes from the environment, is validated at boot by Joi in `src/config/env.schema.ts`, and boot fails if a required variable is missing. Point to `.env.example` for local values rather than restating them (FR-029)
- [x] T055 [US3] Add the further-reading section (FR-028) linking `.specify/memory/constitution.md`, `docs/ASSUMPTIONS.md`, `docs/kafka-acls.md`, `docs/plans/`, and `specs/`
- [x] T056 [US3] Create `scripts/verify-docs.sh` (executable, `set -uo pipefail`, following the `fail`/`ok` idiom of `scripts/verify-uat.sh`) running the README reference check and the Docker-free document checks as one gate. Do NOT modify `scripts/verify-uat.sh` — it encodes phases 1–9 and its header states precisely what it asserts; this is a separate gate (research.md R-007)
- [x] T057 [US3] Make T046 and T047 pass; run `npm run docs:verify` and confirm it exits zero (depends on T048–T056)

**Checkpoint**: All three user stories are independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [x] T058 [P] Record in `docs/ASSUMPTIONS.md` the Constitution Principle V justification for the two unauthenticated documentation routes verbatim from plan.md — contract not tenant data, configuration-gated, unmounted when disabled, no privileged path — plus the decisions from research.md R-002 (no CLI plugin), R-003 (real app under containers), and R-004 (hand-written contract as oracle). Required by Principle VII and by the governance clause that every deviation be recorded
- [x] T059 [P] Verify no file exceeds 800 lines and no function exceeds 50 lines across all files added or modified; split `src/docs/` or the response classes if the decorators pushed any file past the 200–400 line typical range
- [x] T060 [P] Verify no `any` and no non-null assertion was introduced without an inline justification comment across `src/docs/`, `src/capacity/api/`, `src/main.ts`, and `scripts/export-openapi.ts`, per the project's technology constraints
- [ ] T061 Run `npm run test:cov` and confirm the 80% global threshold holds for branches, functions, lines, and statements with the new code included; add unit coverage for any uncovered branch in `src/docs/`
- [ ] T062 Measure bootstrap time with `API_DOCS_ENABLED=true` versus `false` and confirm document generation adds no more than ~250ms, per contracts/docs-endpoints.md Performance
- [x] T063 Execute quickstart.md Scenario 4 end to end: confirm a request without a credential returns `401`, a valid credential against another organisation's program returns `404` and never `403`, and that both hold identically when issued from the documentation page (SC-010, FR-016)
- [x] T064 Execute quickstart.md Scenario 6 end to end: with `API_DOCS_ENABLED=false`, confirm `/docs` and `/docs/openapi.json` return responses INDISTINGUISHABLE from an arbitrary unknown path, and that the API itself is unaffected (SC-009)
- [ ] T065 Execute quickstart.md Scenario 5 with a developer who has not seen this work: clean clone, README only, no questions — confirm a successful API call in under 15 minutes (SC-005)
- [ ] T066 Run the full gate: `npm run typecheck && npm run lint && npm test && npm run test:cov && npm run docs:verify && ./scripts/verify-uat.sh`. All must pass. `verify-uat.sh` passing UNCHANGED is itself the check that nothing in the existing contract moved

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — start immediately
- **Foundational (Phase 2)**: depends on Setup — **BLOCKS all user stories**
- **US1 (Phase 3)**: depends on Foundational only
- **US2 (Phase 4)**: depends on Foundational; shares `docs.bootstrap.ts` with US1 (T040 extends T034)
- **US3 (Phase 5)**: depends on Foundational for the paths it documents; T051 additionally depends on T035 and T040
- **Polish (Phase 6)**: depends on all desired stories

### User Story Dependencies

- **US1 (P1)**: independent once Foundational is done. Ships alone as the MVP.
- **US2 (P2)**: independent in outcome, but T040 edits the same file as T034. If US1 and US2 are worked in parallel, T034 must land first.
- **US3 (P3)**: the most independent of the three — T048–T050 and T052–T056 need nothing from US1 or US2. Only T051 (the documentation links) waits on them.

### Within Each Story

Tests written and observed FAILING → metadata/schemas → decorators → bootstrap wiring →
make tests pass. Never the reverse (Constitution VI).

### Parallel Opportunities

- T003, T004, T005 in Setup
- T007, T008, T009 (all three foundational test specs, different files)
- T010–T016 and T018–T021 (different files; T017 waits on T014–T016)
- T025, T026, T027 in US1; T028, T029, T030, T032 in US1 implementation
- T037, T038, T039 in US2; T041, T042, T043 in US2 implementation
- T046, T047 in US3; T048–T056 are one file each except the README, which is sequential
- Whole stories: with Foundational done, one developer per story — US3 in particular needs almost nothing from the others

---

## Parallel Example: Foundational Phase

```bash
# The three foundational test specs together (different files, all Docker-free):
Task: "Write test/unit/openapi-metadata.spec.ts"
Task: "Write test/unit/openapi-money-typing.spec.ts"
Task: "Write test/unit/openapi-error-codes.spec.ts"

# Then the response classes and DTO decorators together (one file each):
Task: "Create src/capacity/api/response/money.response.ts"
Task: "Create src/capacity/api/response/error.response.ts"
Task: "Create src/capacity/api/response/page.response.ts"
Task: "Create src/capacity/api/response/availability.response.ts"
Task: "Create src/capacity/api/response/reservation.response.ts"
Task: "Create src/capacity/api/response/ledger-entry.response.ts"
Task: "Decorate src/capacity/api/dto/create-reservation.dto.ts"
Task: "Decorate src/capacity/api/dto/create-release.dto.ts"
Task: "Decorate src/capacity/api/dto/cancellation.dto.ts"
Task: "Decorate src/capacity/api/dto/list-reservations.query.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational → 3. Phase 3 US1
4. **STOP and VALIDATE**: run quickstart.md Scenarios 1 and 4
5. Ship. An integrator can now learn the entire API from a browser — the single largest gap this feature closes.

### Incremental Delivery

1. Setup + Foundational → the document exists and is correct
2. US1 → browsable → **MVP**
3. US2 → importable
4. US3 → onboarding, plus the check that keeps the README honest
5. Polish → assumptions recorded, gates green

### Parallel Team Strategy

Foundational is genuinely blocking and should be done by one person or in one sitting — it is
the artefact everything else presents. After it:

- Developer A: US1 (page)
- Developer B: US2 (export), coordinating on `docs.bootstrap.ts` — T034 before T040
- Developer C: US3 (README) — needs nothing from A or B except T051

---

## Notes

- **The conformance spec is the point of this feature.** T025 is what makes FR-002 and FR-031 real. If it is weakened to make a failure go away, the feature has been delivered in name only.
- When the generated document and `specs/001-.../contracts/http-api.yaml` disagree, that is a finding. Establish which is right before changing either.
- `scripts/verify-uat.sh` is deliberately not modified. Its passing unchanged at T066 is evidence that nothing in the existing contract moved.
- `.env.example` and `src/config/env.schema.ts` must always change together (T003 + T004).
- Never hardcode a port. Resolve with `./scripts/dev-stack.sh env`.
- Commit after each task or logical group, `<type>: <description>` conventional format.
- Stop at any checkpoint to validate a story independently.

---

## Phase 7: Convergence

- [ ] T067 Add a Docker-free `test/unit/openapi-validity.spec.ts` that validates the document built by `src/docs/openapi-document.factory.ts` against the OpenAPI 3.1 meta-schema using the repository's existing `Ajv2020` + `ajv-formats` setup (asserting zero errors and unique `operationId`s), and register it in the `npx jest` list in `scripts/verify-docs.sh` so the gate fails on an invalid document per FR-003, FR-032, SC-004 (missing)
- [ ] T068 Add a `test/unit/openapi-examples.spec.ts` asserting that every operation in the generated document carries at least one response example and, where it takes a body, a request example; that every example monetary amount is a digit string; that every example `Idempotency-Key` satisfies the 8–128 character constraint; and that every example program and organisation identifier equals a constant exported from `scripts/seed.ts` — the decorators already carry examples but nothing enforces their completeness or their agreement with the seed per FR-008, SC-007 (partial)
- [ ] T069 Correct the `400` response description on the three write operations in `src/capacity/api/capacity.controller.ts` (currently `'VALIDATION_FAILED or INVALID_AMOUNT'` at the `createReservation`, `createRelease` and `cancelReservation` decorators): `INVALID_AMOUNT` is unreachable over HTTP because `PositiveMoneyDto.amountMinor` carries `@Matches(/^[1-9][0-9]{0,18}$/)` and the global `ValidationPipe` refuses first, so the generated document names a refusal no caller can observe; document only the codes the operation can actually return and update the corresponding note in `docs/ASSUMPTIONS.md` per FR-005 (contradicts)
- [ ] T070 Execute and record the quickstart Scenario 3 import validation (T045): export the document with `npm run openapi:export`, import it into two mainstream API clients, confirm zero import errors, confirm every operation appears as a runnable request, confirm one collection-level bearer token authorises all of them, and confirm `getAvailability` and `createReservation` execute against a seeded instance with no hand-editing — no artefact in the repository evidences this was done per SC-003, US2/AC2, US2/AC3 (missing)
- [ ] T071 Replace the hardcoded `http://localhost:3000/docs` link in the "API documentation" section of `README.md` with the `$PORT`-based form already used by the first-call `curl` example — the README states two sections earlier that ports are allocated per worktree and that 5432/6379/9092 must never be assumed, so the literal `3000` contradicts its own guidance and sends a reader to the wrong port per FR-030 (contradicts)
