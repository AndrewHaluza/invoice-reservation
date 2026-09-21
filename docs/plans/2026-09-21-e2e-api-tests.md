# Execution Plan: End-to-End API Tests for Overbooking, Refusals and Lock Contention

Feature: `004-e2e-api-tests`. Authoritative design artifacts, all already written and
analyze-hardened, live in `specs/004-e2e-api-tests/`: `spec.md` (17 FR, 8 SC), `plan.md`,
`research.md` (R-001..R-010), `data-model.md`, `contracts/e2e-command.md`,
`contracts/fixture-contract.md`, `quickstart.md`, `tasks.md` (T001–T029),
`checklists/requirements.md`. This plan sequences that work into 12 tasks, each runnable by
a fresh sub-agent with no memory of the others.

Branch: `develop`.

## Goal

A new, separately-invoked Jest suite under `test/e2e/` that drives the real `AppModule` over
HTTP and proves four things no existing test proves: the four reachable capacity refusals
that have never been observed over HTTP, the capacity boundary at its exact edge, that
concurrent writes to one program never surface as failures, and that all of this happens
without changing the behaviour of any existing command.

## Current State

- `jest.config.ts` has `roots: ['<rootDir>/src', '<rootDir>/test']` and
  `testRegex: '.*\.spec\.ts$'`, with `testPathIgnorePatterns:
  ['/node_modules/', 'test/integration/ledger-recovery\.spec\.ts$', 'test/performance/']`
  and a global 80% `coverageThreshold`. **Any `*.spec.ts` created under `test/` joins
  `npm test` and `npm run test:cov` automatically** unless an ignore entry is added.
- The repository already uses one extra Jest config per excluded suite:
  `jest.recovery.config.ts`, `jest.perf.config.ts` (both spread `base` from `./jest.config`
  and override `testPathIgnorePatterns` + `testRegex`), plus `jest.mutation.config.js`.
- `test/integration/reserve-endpoint.spec.ts:98-165` holds the only proven bootstrap of the
  full `AppModule` over HTTP against testcontainers.
- `test/support/` already provides `postgres-container.ts` (`startPostgres()` →
  `{ container, ownerUrl, appUrl, stop }`), `redis-container.ts` (`startRedis()` →
  `{ url, stop }`), `treasury.ts` (`buildTreasuryHarness`, `snapshotMessage`,
  `capacityEventMessage`, `insertOrganisation`, `insertProgram`, `insertLocalReservation`)
  and `openapi.ts`.
- `scripts/seed.ts` exports `NORTHWIND_ORGANISATION_ID`, `CONTOSO_ORGANISATION_ID`,
  `NORTHWIND_USD_PROGRAM_ID`, `NORTHWIND_EUR_PROGRAM_ID`, `CONTOSO_USD_PROGRAM_ID`,
  `TOKEN_SCOPE`.
- Routes, from `src/capacity/api/capacity.controller.ts` (`@Controller('v1/programs/:programId')`):
  - `POST reservations` — body `{ invoiceId, amount: { amountMinor, currency } }`
  - `POST reservations/:invoiceId/releases` — body `{ amount: { amountMinor, currency } }`
  - `POST reservations/:invoiceId/cancellation` — body `{ reason: 'CANCELLED' | 'WRITTEN_OFF', note?: string }`
  - `GET availability`, `GET reservations`, `GET reservations/:invoiceId`
  - `programId` is parsed by `new ParseUUIDPipe({ version: '4' })`; `idempotency-key` is read
    from the request header.
- `src/capacity/application/idempotency.service.ts` inserts a `request_record` row
  (`PENDING`), and on a key collision returns `IDEMPOTENCY_CONFLICT` when `operation` or
  `content_fingerprint` differ, otherwise `REQUEST_IN_FLIGHT` for `PENDING`,
  `IDEMPOTENCY_EXPIRED` for `EXPIRED`, and a replay for `COMPLETE`. The reserve fingerprint
  is `sha256("<programId>|<invoiceId>|<amountMinor>|<currency>")`, hex.
- `src/capacity/api/error.filter.ts` maps `PROGRAM_OVER_LIMIT`, `INSUFFICIENT_CAPACITY`,
  `DUPLICATE_INVOICE`, `IDEMPOTENCY_EXPIRED`, `REQUEST_IN_FLIGHT` all to HTTP **409**.
- `src/capacity/application/apply-snapshot.service.ts` quarantines a snapshot whose
  `|delta_treasury|` exceeds `SNAPSHOT_DELTA_GUARD_RATIO` (default `0.5`) times the credit
  limit, and one whose `version` is not greater than `program.treasury_version`.
- `.github/workflows/ci.yml` has one job, `gate`, `runs-on: ubuntu-latest`,
  `timeout-minutes: 30`, steps in order: `npm ci`, Lint, Typecheck, Test, Coverage gate, Build.
- `test/unit/readme-references.spec.ts` asserts the README `npm run <name>` tokens all exist
  in `package.json`'s `scripts`. It runs in `npm test` **and** in `npm run docs:verify`.

## Target State

New files: `jest.e2e.config.ts`, `test/support/e2e-app.ts`, `test/e2e/refusals.spec.ts`,
`test/e2e/capacity-boundary.spec.ts`, `test/e2e/contention.spec.ts`,
`specs/004-e2e-api-tests/baseline.md`.

Modified files: `jest.config.ts` (one array entry), `package.json` (one script),
`.github/workflows/ci.yml` (one step), `docs/ASSUMPTIONS.md` (four entries), `README.md`,
`CLAUDE.md`, `specs/004-e2e-api-tests/tasks.md` (checkboxes).

No file under `src/` changes. No existing test changes. `package-lock.json` ends with an
empty diff. `npm test`, `npm run test:cov`, `npm run test:unit`, `npm run test:recovery`,
`npm run test:perf`, `npm run test:mutation`, `npm run typecheck`, `npm run lint`,
`npm run build` and `npm run docs:verify` all behave exactly as before.

## Scope

### In Scope

- The isolated `test:e2e` runner and its CI step.
- Four refusal codes observed over HTTP for the first time: `PROGRAM_OVER_LIMIT`,
  `DUPLICATE_INVOICE`, `REQUEST_IN_FLIGHT`, `IDEMPOTENCY_EXPIRED`.
- The capacity boundary at `available`, `available + 1`, and after a release.
- Five simultaneous writes to one program, plus a mixed-operation burst.
- Two deliberate red steps (T024, T029) proving the new assertions can fail.
- Documentation, recorded assumptions, and the isolation proof.

### Out of Scope

- Re-asserting idempotent replay or RBAC/scope/cross-organisation behaviour. Both are
  already covered end to end by `test/integration/reserve-endpoint.spec.ts` and the contract
  specs; FR-012 forbids duplicating them. This is the feature's largest decision and is
  recorded in `docs/ASSUMPTIONS.md` by Task 8.
- A multi-program deadlock scenario. `src/capacity/infrastructure/unit-of-work.ts` locks
  exactly one program per transaction and every write route is mounted under
  `v1/programs/:programId`, so no supported request can express it (R-006). FR-013 forbids
  simulating it below the API and calling the result end-to-end evidence.
- `INVALID_AMOUNT` over HTTP. `CreateReleaseDto.amount` is a `PositiveMoneyDto` whose
  `amountMinor` carries `@Matches(/^[1-9][0-9]{0,18}$/)`, so the global `ValidationPipe`
  returns `400 VALIDATION_FAILED` before the domain guard runs (R-010).
- Any change to `src/`, to an existing test, or to a dependency.

## Key Decisions

1. **A fourth Jest config, not a `testPathIgnorePatterns`-free run.** `jest.e2e.config.ts`
   spreads `base` and overrides `testPathIgnorePatterns` and `testRegex`, exactly as
   `jest.recovery.config.ts` does. This is the repository's established pattern for an
   excluded suite; it is the reason the suite can be excluded from `npm test` without
   inventing a second mechanism.

2. **The T004 baseline crosses task boundaries as a committed file**, not as session memory.
   Task 1 writes `specs/004-e2e-api-tests/baseline.md` containing the exact suite count, test
   count and four coverage percentages from a clean `npm test` / `npm run test:cov`. Task 11
   re-runs both and compares against that file. Sub-agents share no context; a number kept in
   a head does not survive.

3. **Documentation is written after the script exists.** `test/unit/readme-references.spec.ts`
   fails if the README names an `npm run` script absent from `package.json`, and that spec
   runs in both `npm test` and `npm run docs:verify`. Task 9 (README + CLAUDE.md) therefore
   depends on Task 1 (the `test:e2e` script). Reordering turns two gates red.

4. **The over-limit precondition is established through the treasury handler, and only that
   one.** No sequence of HTTP requests can put a program over its limit — the database
   constrains `local_reserved_minor` against the credit limit. FR-001a permits establishing
   exactly this one state through the inbound handler, and requires the scenario to assert
   the precondition holds before issuing its request. Everything else in the suite is
   established over HTTP or by inserting a fresh fixture row.

5. **The local reserved portion of the over-limit fixture is built over HTTP**, not by
   inserting a pre-loaded program row. A `POST reservations` for 900,000 against a 1,000,000
   limit is a real write through the real ledger; only the treasury half of the position
   needs the handler. This keeps the fixture as close to FR-001 as the state allows.

6. **The idempotency fingerprint is recomputed in the test, not imported.** FR-015 limits the
   suite's `src/` imports to `src/app.module` and
   `src/shared/validation/create-validation-pipe` (plus `scripts/seed`). The test computes
   `createHash('sha256').update(`${programId}|${invoiceId}|${amountMinor}|${currency}`).digest('hex')`
   itself. Importing `reserveFingerprint` would reach into the application layer and would
   also make the test agree with the implementation by construction rather than by assertion.

7. **`REQUEST_IN_FLIGHT` and `IDEMPOTENCY_EXPIRED` are set up by inserting a `request_record`
   row directly.** Both are states of the idempotency table, not of the ledger; F-3.3's
   prohibition is on setting a **position** behind the ledger's back, which this is not.
   A `PENDING` row cannot be produced deterministically over HTTP without a race, and an
   `EXPIRED` row would require waiting out `REQUEST_RETENTION_DAYS` (default 30).

8. **Each scenario gets its own organisation and its own program row** (F-2.1). No scenario
   reuses another's fixture, so ordering between scenarios inside a file never matters.

9. **Five concurrent requests, not a thousand.** `test/integration/concurrency.spec.ts`
   already runs the thousand-request storm and FR-012 forbids duplicating it. Five is enough
   to serialize on the row lock.

10. **The two red steps run on a scratch copy and are never committed.** FR-010 forbids
    changing production behaviour; T024's mutation of `reserve.policy.ts` and T029's broken
    assertion are throwaway probes, each followed by a `git status --porcelain` clean check.

## Execution Order

### Task 1: Create the isolated e2e runner and record the pre-change baseline

#### Objective

`npm run test:e2e` exists and runs only `test/e2e/`; `npm test` and `npm run test:cov` are
provably unchanged; their numbers are committed for Task 11 to compare against.

Covers `tasks.md` T001, T002, T003, T004.

#### Files

- `jest.e2e.config.ts` — CREATE. The runner config.
- `jest.config.ts` — MODIFY. One new `testPathIgnorePatterns` entry.
- `package.json` — MODIFY. One new script.
- `specs/004-e2e-api-tests/baseline.md` — CREATE. The recorded baseline.
- `specs/004-e2e-api-tests/tasks.md` — MODIFY. Tick T001–T004.

#### Implementation

1. **Record the baseline first, before any file changes.** From a clean working tree run:
   ```bash
   npm test 2>&1 | tail -20
   npm run test:cov 2>&1 | tail -30
   ```
   Capture, verbatim: the `Test Suites:` line, the `Tests:` line, and the four `All files`
   coverage percentages (statements, branches, functions, lines).

2. Create `jest.e2e.config.ts`:
   ```ts
   import type { Config } from 'jest';
   import base from './jest.config';

   // Runs ONLY the end-to-end API suite, which the default `npm test` excludes
   // because every scenario boots the whole application against its own
   // Postgres and Redis containers. Keeping it out of the default run also
   // keeps it out of the 80% coverage gate, which measures `src/` only.
   const config: Config = {
     ...base,
     testPathIgnorePatterns: ['/node_modules/'],
     testRegex: 'test/e2e/.*\\.spec\\.ts$',
   };

   export default config;
   ```

3. In `jest.config.ts`, add `'test/e2e/'` as a new final element of
   `testPathIgnorePatterns`, immediately after `'test/performance/'`. Change nothing else in
   that file (contract C-4.2).

4. In `package.json`, add `"test:e2e": "jest --config jest.e2e.config.ts"` to `scripts`,
   immediately after the `"test:perf"` entry. Add no dependency: per R-008 every package the
   suite needs (`jest`, `ts-jest`, `supertest`, `@types/supertest`, `jsonwebtoken`,
   `typeorm`, `@nestjs/testing`, `@testcontainers/postgresql`, `testcontainers`) is already a
   direct devDependency or dependency.

5. Create `specs/004-e2e-api-tests/baseline.md` with exactly this shape, filled with the
   numbers from step 1:
   ```markdown
   # Pre-change baseline for feature 004

   Recorded before any file was created under `test/e2e/`, on <ISO date>, commit `<sha>`.
   Task 11 (`tasks.md` T025) re-runs both commands and compares. A changed number means the
   `test/e2e/` entry in `jest.config.ts` `testPathIgnorePatterns` is missing and the suite
   has joined the default run, breaching FR-011.

   ## `npm test`

   - Test Suites: <n> passed, <n> total
   - Tests: <n> passed, <n> total

   ## `npm run test:cov`

   - Statements: <x>%
   - Branches: <x>%
   - Functions: <x>%
   - Lines: <x>%
   ```

6. Do **not** create `test/e2e/` in this task.

#### Constraints

- `jest.config.ts`: exactly one line added. No reordering, no reformatting.
- `package.json`: exactly one script added. Do not run `npm install` — `package-lock.json`
  must end with an empty diff.
- Do not touch `jest.recovery.config.ts`, `jest.perf.config.ts`, `jest.mutation.config.js`
  or `stryker.config.mjs`.

#### Edge Cases

- `npm run test:e2e` at the end of this task finds no test files and **exits non-zero** with
  "no tests found". That is the expected, correct result here — it proves the `testRegex` is
  scoped to `test/e2e/` and is not falling through to the default suites. Do not add a
  placeholder test to make it green.
- If `npm test` is already red before any change, stop and report: the baseline is
  meaningless and every later comparison is void.

#### Verification

```bash
npm run test:e2e; echo "exit=$?"
npm test
npm run test:cov
npm run typecheck
npm run lint
git diff --stat jest.mutation.config.js stryker.config.mjs jest.recovery.config.ts jest.perf.config.ts package-lock.json
```

Expected:
- `test:e2e` exits non-zero, output contains "no tests found", and names **no** file under
  `test/unit`, `test/integration`, `test/contract`, `test/migration` or `test/performance`.
- `npm test` and `npm run test:cov` report the same numbers now recorded in `baseline.md`.
- `typecheck` and `lint` pass.
- The `git diff --stat` prints nothing.

#### Completion Criteria

- [ ] `jest.e2e.config.ts` exists and mirrors `jest.recovery.config.ts` in shape.
- [ ] `jest.config.ts` `testPathIgnorePatterns` ends with `'test/e2e/'` and has no other change.
- [ ] `package.json` has `test:e2e` after `test:perf`; `package-lock.json` diff is empty.
- [ ] `specs/004-e2e-api-tests/baseline.md` exists with real numbers, no placeholders.
- [ ] No directory `test/e2e/` exists yet.
- [ ] T001–T004 ticked in `specs/004-e2e-api-tests/tasks.md`.

---

### Task 2: Build the shared end-to-end application fixture

#### Objective

`test/support/e2e-app.ts` starts the real `AppModule` over HTTP against fresh containers and
tears it down cleanly, so a spec file contains scenarios and nothing else.

Covers `tasks.md` T005, T006.

#### Files

- `test/support/e2e-app.ts` — CREATE.
- `specs/004-e2e-api-tests/tasks.md` — MODIFY. Tick T005, T006.

#### Implementation

Copy the proven sequence from `test/integration/reserve-endpoint.spec.ts:98-165`. **The
order below is load-bearing; two steps are correctness requirements, not style.**

Export an interface and two functions:

```ts
export interface E2eApp {
  app: INestApplication;
  owner: DataSource;          // the OWNER connection, for fixture setup and row reads
  postgres: PostgresFixture;
  redis: RedisFixture;
  savedEnv: Map<string, string | undefined>;
}

export async function startE2eApp(): Promise<E2eApp>;
export async function stopE2eApp(fixture: E2eApp | undefined): Promise<void>;
export function tokenFor(organisationId: string, scope: string): string;
export const JWT_SECRET: string;          // a fixed 32+ character constant
export const WRITE_SCOPE = 'capacity:write';
export const READ_SCOPE = 'capacity:read';
```

`startE2eApp`, in order:

1. `postgres = await startPostgres()` from `./postgres-container`;
   `redis = await startRedis()` from `./redis-container`.
2. Save-and-set each environment variable through a local helper that records the previous
   value into `savedEnv` before overwriting. Set: `MIGRATION_DATABASE_URL` and
   `DATABASE_URL` both to `postgres.ownerUrl`; `REDIS_URL` to `redis.url`; `KAFKA_BROKERS`
   to `'localhost:9093'`; `KAFKA_LAG_PROBE_ENABLED` to `'false'`; `KAFKA_SASL_USERNAME` to
   `'capacity'`; `KAFKA_SASL_PASSWORD` to `'capacity_local_dev'`; `JWT_SECRET` to the
   exported constant; `RATE_LIMIT_READ_PER_MINUTE` to `'600'`;
   `RATE_LIMIT_WRITE_PER_MINUTE` to `'120'`.
3. `const { dataSourceOptions } = await import('../../src/config/data-source');` then open
   `owner = new DataSource({ ...dataSourceOptions, url: postgres.ownerUrl, entities: [] })`,
   `await owner.initialize()`, `await owner.runMigrations()`.
4. Seed the two FX pairs the existing HTTP specs seed:
   ```sql
   INSERT INTO fx_rate (base_currency, quote_currency, effective_at, rate, source)
   VALUES ('EUR', 'USD', to_timestamp(0), '1.0850000000', 'seed'),
          ('USD', 'EUR', to_timestamp(0), '0.9216589862', 'seed')
   ```
5. **Switch `DATABASE_URL` to `postgres.appUrl` before importing `AppModule`.**
   `DATABASE_URL` connects as `capacity_app`, which is not the table owner, so the ledger's
   `REVOKE UPDATE, DELETE` actually binds. Leaving the owner URL in place lets the
   application rewrite history, and the suite then passes while testing a permission model
   production does not have.
6. `const { AppModule } = await import('../../src/app.module');`
   `const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();`
   `const app = moduleRef.createNestApplication();`
   `app.useGlobalPipes(createValidationPipe());` (from
   `../../src/shared/validation/create-validation-pipe`).
7. **`await app.listen(0)` — not `init()`.** With `init()` alone, supertest starts and tears
   down the HTTP server around individual requests; under parallel load that race surfaces as
   a raw, body-less `501`/`404` that never reached the Nest pipeline — exactly the symptom
   User Story 3 exists to disprove. Reproduce this reasoning as a comment in the file.

`tokenFor(organisationId, scope)` signs `{ org: organisationId, scope, exp: <now + 3600s> }`
with `JWT_SECRET` and `{ algorithm: 'HS256' }`, using `sign` from `jsonwebtoken`.

`stopE2eApp(fixture)`, in this order, each step individually guarded so a setup failure
cannot cascade into a teardown crash that hides the original error (contract F-6):

1. If `fixture` is undefined, return.
2. If `fixture.app` exists: `const storage = fixture.app.get(ThrottlerStorage) as
   ThrottlerStorageRedisService;` then `await fixture.app.close();` then
   `storage.redis.disconnect();`. **Closing the app alone leaves the Redis client open and
   Jest hangs.**
3. If `fixture.owner?.isInitialized`, `await fixture.owner.destroy()`.
4. Restore every entry of `savedEnv`: `delete process.env[key]` when the saved value is
   `undefined`, otherwise assign it back.
5. `await fixture.redis?.stop()`, then `await fixture.postgres?.stop()`.

#### Constraints

- Permitted `src/` imports in this file: `src/config/data-source` (dynamic, for
  `dataSourceOptions`), `src/app.module` (dynamic), and
  `src/shared/validation/create-validation-pipe`. No other `src/` import.
- Do not modify `test/support/postgres-container.ts`, `test/support/redis-container.ts` or
  `test/support/treasury.ts`.
- Do not hardcode ports 5432, 6379 or 9092 — every port comes from the container fixtures.
- `JWT_SECRET` must be at least 32 characters (`env.schema.ts` enforces `min(32)`). Use the
  literal `'e2e-test-secret-0123456789abcdefghij'`. This is a throwaway test value, not a
  credential.

#### Edge Cases

- A container that fails to start leaves `app` and `owner` undefined; `stopE2eApp` must still
  stop whatever did start, and must not throw.
- `app.get(ThrottlerStorage)` throws if the module never compiled; guard it in a `try`.

#### Verification

```bash
npm run typecheck
npm run lint
git diff --stat test/
```

Expected:
- `typecheck` and `lint` pass.
- `git diff --stat test/` names `test/support/e2e-app.ts` and nothing else.
- No test run is expected in this task — there is no spec file yet.

#### Completion Criteria

- [ ] `test/support/e2e-app.ts` exports `startE2eApp`, `stopE2eApp`, `tokenFor`,
      `JWT_SECRET`, `WRITE_SCOPE`, `READ_SCOPE`.
- [ ] `DATABASE_URL` is switched to `postgres.appUrl` **before** the `AppModule` import, with
      a comment explaining why.
- [ ] The listener is bound with `app.listen(0)`, with a comment explaining why not `init()`.
- [ ] Teardown reads `ThrottlerStorage`, closes the app, then disconnects Redis, in that order.
- [ ] No existing file under `test/` was modified.
- [ ] T005, T006 ticked in `tasks.md`.

---

### Task 3: Prove the bootstrap, then add the over-limit refusal and its clearance

#### Objective

`test/e2e/refusals.spec.ts` exists, boots the application, and asserts
`PROGRAM_OVER_LIMIT` over HTTP for the first time, plus its clearance.

Covers `tasks.md` T007, T008, T009.

#### Files

- `test/e2e/refusals.spec.ts` — CREATE.
- `specs/004-e2e-api-tests/tasks.md` — MODIFY. Tick T007, T008, T009.

#### Implementation

**Step A — bootstrap only.** Create the file with `jest.setTimeout(300_000)`, a `beforeAll`
calling `startE2eApp()`, an `afterAll` calling `stopE2eApp()`, and **no scenario**. Run
`npm run test:e2e` and confirm the containers start, the application boots, and Jest reports
zero tests in the file. This isolates a bootstrap or wiring failure from an assertion
failure. Only then continue.

**Step B — the over-limit scenario**, following contract F-4:

1. `const organisationId = await insertOrganisation(owner, 'e2e-over-limit');` and
   `const programId = await insertProgram(owner, organisationId, { currency: 'USD',
   creditLimitMinor: 1_000_000 });` — both from `test/support/treasury.ts`. `insertProgram`
   sets `position_verified` true and `treasury_version` 0 by default.
2. Build the local half of the position **over HTTP**: `POST
   /v1/programs/${programId}/reservations` with a write-scoped token, an `Idempotency-Key`,
   and `{ invoiceId: 'inv-over-limit-seed', amount: { amountMinor: '900000', currency: 'USD' } }`.
   Assert `201`.
3. `const harness = buildTreasuryHarness(owner);` then apply
   ```ts
   await harness.snapshotHandler.handle(snapshotMessage({
     programId,
     version: 1,
     currency: 'USD',
     creditLimitMinor: '1000000',
     reservedMinor: '400000',
   }));
   ```
   `400000` is chosen deliberately: the treasury delta is `400000 - 0`, which is **below**
   the `SNAPSHOT_DELTA_GUARD_RATIO` (0.5) times the 1,000,000 credit limit, so the snapshot
   is applied rather than quarantined as `IMPLAUSIBLE_DELTA`. `version: 1` is above the
   program's `treasury_version` of 0, so it is not rejected as stale.
4. **Assert the precondition.** Read the program row back:
   ```sql
   SELECT credit_limit_minor, local_reserved_minor, treasury_reserved_minor
     FROM program WHERE id = $1
   ```
   and assert with `BigInt` arithmetic that
   `local + treasury > creditLimit` (900,000 + 400,000 > 1,000,000).
   This is not decoration. If the snapshot were quarantined — by the delta guard, by a stale
   version, or by a missing acknowledgement marker — the program would still be within its
   limit, the next reservation would return `201`, and a reader would blame the refusal logic
   rather than the fixture.
5. `POST` a further reservation, `{ invoiceId: 'inv-over-limit-1', amount: { amountMinor:
   '1', currency: 'USD' } }`, with a write-scoped token and a fresh `Idempotency-Key`.
   Assert `response.status === 409`, `response.body.code === 'PROGRAM_OVER_LIMIT'`, and that
   `local_reserved_minor` read back from the row is still `900000`.

**Step C — the clearance scenario**, in its own `it(...)`, against **its own fresh
organisation and program** (F-2.1 — do not reuse Step B's rows). Repeat steps 1–4 to reach
the over-limit state, then apply a second snapshot with `version: 2` and
`reservedMinor: '0'` (delta `-400000`, again inside the guard), assert the program row is
back within its limit, then `POST` a reservation for `'50000'` and assert `201` **and** read
`local_reserved_minor` back and confirm it is `950000`. FR-005 applies to every scenario that
writes, not only to the refusals. This proves the refusal is a function of position, not a
sticky flag.

#### Constraints

- **Do not** write `over_limit_since` directly (F-3.4): `isOverLimit` in
  `src/capacity/domain/program.ts` recomputes from the position and never reads that column,
  so such a fixture proves nothing.
- **Do not** set the position with `UPDATE` (F-3.3): Principle II forbids setting a position
  behind the ledger's back.
- Every assertion must be on an HTTP response body or on a row read back from the database.
  Never assert on a service, repository or policy return value (F-3.5). The
  `snapshotHandler.handle(...)` call is **setup**, permitted by FR-001a for this one state
  because no HTTP route can produce it; its result is not asserted on.
- Permitted imports: `supertest`, `jsonwebtoken` (indirectly via `tokenFor`), `typeorm`,
  `test/support/e2e-app`, `test/support/treasury`. No `src/` import beyond what
  `e2e-app.ts` already makes.
- Money is `bigint` minor units throughout, sent and asserted as decimal strings. No
  floating-point step anywhere, including in the test's own arithmetic.

#### Edge Cases

- If the snapshot is silently quarantined, step 4's precondition assertion fails first and
  names the real problem. That is the designed behaviour — do not soften it into a warning.
- `insertProgram` defaults `local_reserved_minor` to 0; do not pass it, the HTTP reservation
  in step 2 establishes it.

#### Verification

```bash
npm run test:e2e -- -t 'over-limit'
npm run typecheck
npm run lint
```

Expected:
- Both over-limit scenarios pass.
- `typecheck` and `lint` pass.

#### Completion Criteria

- [ ] `test/e2e/refusals.spec.ts` exists with the shared bootstrap and teardown.
- [ ] A scenario asserts `409` + `body.code === 'PROGRAM_OVER_LIMIT'` over HTTP.
- [ ] That scenario asserts the over-limit precondition from the program row before issuing
      the request.
- [ ] A clearance scenario asserts `201` and reads `local_reserved_minor` back.
- [ ] The two scenarios use different organisations and different programs.
- [ ] T007, T008, T009 ticked in `tasks.md`.

---

### Task 4: Add the duplicate-invoice and idempotency-state refusals

#### Objective

`DUPLICATE_INVOICE`, `REQUEST_IN_FLIGHT` and `IDEMPOTENCY_EXPIRED` each asserted over HTTP
with their specific code, and the fourteenth refusal code documented as unreachable.

Covers `tasks.md` T010, T011.

#### Files

- `test/e2e/refusals.spec.ts` — MODIFY. Three scenarios plus a header comment.
- `specs/004-e2e-api-tests/tasks.md` — MODIFY. Tick T010, T011.

#### Implementation

**Scenario 1 — `DUPLICATE_INVOICE`.** Fresh organisation and program
(`creditLimitMinor: 1_000_000`). `POST` a reservation for `invoiceId: 'inv-dup-1'`,
`amountMinor: '100000'`, `Idempotency-Key: 'dup-key-a'` → assert `201`. `POST` **the same
`invoiceId`** against the same program with a **different** `Idempotency-Key`
(`'dup-key-b'`) → assert `409` and `body.code === 'DUPLICATE_INVOICE'`. Read
`local_reserved_minor` back and assert it is `100000` — exactly one reservation.

The differing key is what makes this a duplicate-invoice refusal rather than an idempotency
replay: with the same key the service returns `200` with the original body and the scenario
would prove nothing. State this in a comment.

**Scenario 2 — `REQUEST_IN_FLIGHT`.** Fresh organisation and program. Insert a
`request_record` row directly as the owner:

```sql
INSERT INTO request_record
  (organisation_id, request_id, operation, content_fingerprint, state, outcome, recorded_at)
VALUES ($1, $2, 'RESERVE', $3, 'PENDING', NULL, now())
```

where `$2` is the `Idempotency-Key` the request will carry and `$3` is
`createHash('sha256').update(`${programId}|${invoiceId}|${amountMinor}|${currency}`).digest('hex')`
computed in the test with `node:crypto`. The fingerprint **must match**, otherwise
`IdempotencyService.begin` returns `IDEMPOTENCY_CONFLICT` and the scenario asserts the wrong
code. Then `POST` that exact reservation with that key and assert `409` and
`body.code === 'REQUEST_IN_FLIGHT'`.

**Scenario 3 — `IDEMPOTENCY_EXPIRED`.** Identical to scenario 2 except the inserted row has
`state` `'EXPIRED'` and a `recorded_at` well in the past (`now() - interval '60 days'`;
`REQUEST_RETENTION_DAYS` defaults to 30). Assert `409` and
`body.code === 'IDEMPOTENCY_EXPIRED'`.

Asserting merely "refused" is insufficient. Principle IV distinguishes four outcomes —
matching replay, content conflict, in-flight, expired — and conflating them is the defect
these scenarios exist to catch.

**Every scenario in this file** must additionally assert, per F-5.5, that the response body
carries no `stack`, `sql` or `query` key **at any depth**. Add a small local helper that
walks the parsed body recursively and collect it into each scenario's assertions.

**Header comment.** At the head of the file, record the fourteenth refusal code and why it is
absent: `INVALID_AMOUNT` is raised by `releasePolicy` for a non-positive release amount, but
`CreateReleaseDto.amount` is a `PositiveMoneyDto` whose `amountMinor` carries
`@Matches(/^[1-9][0-9]{0,18}$/)`, so the global `ValidationPipe` returns
`400 VALIDATION_FAILED` before the domain guard runs (R-010). SC-006 requires a reviewer to
name **both** unreachable cases from the suite alone; note that the other one is recorded at
the head of `test/e2e/contention.spec.ts`.

#### Constraints

- Do not import `reserveFingerprint` or anything else from
  `src/capacity/application/idempotency.service.ts`. Compute the hash in the test (Key
  Decision 6).
- Each scenario owns its organisation, program, `invoiceId` and `Idempotency-Key`.
- The `request_record` insert is fixture setup for the idempotency table, not a position
  write; do not extend this technique to the `program` row.

#### Edge Cases

- A fingerprint mismatch produces `IDEMPOTENCY_CONFLICT`, not the intended code. If a
  scenario fails that way, the fingerprint string is wrong — the field order is
  `programId|invoiceId|amountMinor|currency`, with the amount exactly as sent over the wire.
- `request_record` has a composite primary key `(organisation_id, request_id)`; a repeated
  `request_id` across scenarios in the same organisation would collide. Use a distinct key
  per scenario.

#### Verification

```bash
npm run test:e2e
npm run typecheck
npm run lint
grep -n "PROGRAM_OVER_LIMIT\|DUPLICATE_INVOICE\|REQUEST_IN_FLIGHT\|IDEMPOTENCY_EXPIRED" test/e2e/refusals.spec.ts
```

Expected:
- Every scenario in `refusals.spec.ts` passes.
- The grep finds each of the four codes asserted against a response body.

#### Completion Criteria

- [ ] `DUPLICATE_INVOICE`, `REQUEST_IN_FLIGHT`, `IDEMPOTENCY_EXPIRED` each asserted with
      status `409` and the specific `body.code`.
- [ ] Every scenario in the file asserts the body has no `stack`, `sql` or `query` key at
      any depth.
- [ ] The header comment records `INVALID_AMOUNT` as unreachable, with the reason.
- [ ] T010, T011 ticked in `tasks.md`.

---

### Task 5: Pin the capacity boundary at its exact edge

#### Objective

`test/e2e/capacity-boundary.spec.ts` proves the boundary at `available`, at `available + 1`,
and after capacity is returned.

Covers `tasks.md` T012, T013, T014, T015, T016.

#### Files

- `test/e2e/capacity-boundary.spec.ts` — CREATE.
- `specs/004-e2e-api-tests/tasks.md` — MODIFY. Tick T012–T016.

#### Implementation

Create the file with the shared bootstrap (`startE2eApp`) and teardown (`stopE2eApp`) from
`test/support/e2e-app.ts`, then three scenarios, **each against its own fresh organisation
and program**.

Before writing them, note the refusal check order from `data-model.md`:
`POSITION_UNVERIFIED` → `PROGRAM_OVER_LIMIT` → `FX_RATE_UNAVAILABLE` →
`AMOUNT_ROUNDS_TO_ZERO` → `INSUFFICIENT_CAPACITY`. Any of the first four left unsatisfied
means the boundary comparison is never reached and the test passes for the wrong reason.
Every program in this file therefore has `position_verified` true (the `insertProgram`
default), a total within its limit, and a currency matching the request (`'USD'` on both
sides, so no FX conversion is involved).

**Scenario 1 — exactly available.** `insertProgram(owner, organisationId,
{ currency: 'USD', creditLimitMinor: 1_000_000 })`. Compute
`available = creditLimitMinor - (localReserved + treasuryReserved)` in `bigint`, reading all
three from the program row. Reserve exactly `available.toString()`. Assert `201` and that
the reflected availability in the response reports nothing remaining
(`body.availability.available.amountMinor === '0'`). Then read `local_reserved_minor` back
and assert it equals `available`.

**Scenario 2 — one over.** Fresh program. Reserve `(available + 1n).toString()`. Assert
`409`, `body.code === 'INSUFFICIENT_CAPACITY'`, and assert **both**
`body.details.requestedMinor` and `body.details.availableMinor` as decimal strings — the
policy in `src/capacity/domain/policies/reserve.policy.ts` sets both, and asserting them
pins the arithmetic rather than just the outcome. Then read `local_reserved_minor` back and
assert it is unchanged at `0`.

Record in a comment why this pair matters: it is what kills a `>` → `>=` mutation in
`reserve.policy.ts`. That mutation changes behaviour for exactly one input — a request for
precisely the remaining amount — and the existing thousand-request storm in
`test/integration/concurrency.spec.ts` reserves 1,000 against a 100,000 limit, so no request
in it ever lands on the edge.

**Scenario 3 — capacity returns.** Fresh program with `creditLimitMinor: 1_000_000`. Reserve
the full `available` (one reservation, `invoiceId: 'inv-boundary-return'`) → `201`. Confirm a
further reservation of `'1'` is refused `409 INSUFFICIENT_CAPACITY`. Then `POST
/v1/programs/${programId}/reservations/inv-boundary-return/releases` with body
`{ amount: { amountMinor: '250000', currency: 'USD' } }` and its own `Idempotency-Key` →
assert `201`. Read `local_reserved_minor` back and assert it dropped by `250000`. Then
reserve `'250000'` under a new `invoiceId` and assert `201`, and read
`local_reserved_minor` back and assert it is again the full `available`. This proves released
capacity re-enters the boundary calculation rather than leaking.

#### Constraints

- Every amount sent and asserted is a decimal string in minor units with an explicit
  currency, and every computation is `bigint`. Principle I forbids a floating-point step
  anywhere, including in the test's own arithmetic. No `Number()`, no `parseInt`, no `+`
  on numeric literals for money.
- Each scenario owns its organisation and program (F-2.1).
- Assertions come only from HTTP responses and database row reads.
- Do not modify `test/integration/concurrency.spec.ts` or any other existing test.

#### Edge Cases

- If `available` is computed as `0` because the fixture already consumed the limit, scenario
  1 would reserve `'0'`, which the `PositiveMoneyDto` regex rejects with `400
  VALIDATION_FAILED`. Assert `available > 0n` before issuing the request.
- A release of more than the outstanding reserved amount returns `409
  RELEASE_EXCEEDS_RESERVED`; `250000` against a `900000`+ reservation is safely inside it.

#### Verification

```bash
npm run test:e2e -- -t 'boundary'
npm run typecheck
npm run lint
```

Expected:
- All three scenarios pass, and the per-suite time Jest reports for this file is under 30
  seconds excluding container start-up (SC-002).

#### Completion Criteria

- [ ] Scenario at exactly `available` asserts `201` and nothing remaining.
- [ ] Scenario at `available + 1` asserts `409`, `INSUFFICIENT_CAPACITY`, and both
      `details.requestedMinor` and `details.availableMinor`.
- [ ] Scenario proving released capacity is reusable asserts `201` after the release.
- [ ] All three read `local_reserved_minor` back from the program row.
- [ ] No floating-point arithmetic anywhere in the file.
- [ ] T012–T016 ticked in `tasks.md`.

---

### Task 6: Prove contention on one program never surfaces as a failure

#### Objective

`test/e2e/contention.spec.ts` shows five simultaneous writes to one program all complete
with an exact resulting position, and a mixed burst behaves the same.

Covers `tasks.md` T017, T018, T019, T020, T021.

#### Files

- `test/e2e/contention.spec.ts` — CREATE.
- `specs/004-e2e-api-tests/tasks.md` — MODIFY. Tick T017–T021.

#### Implementation

Create the file with the shared bootstrap and teardown from `test/support/e2e-app.ts`.

**Scenario 1 — simultaneous reservations.** One fresh organisation, one fresh program with
capacity for all of them (`creditLimitMinor: 1_000_000`). Issue **exactly five** reservations
at once — build five `supertest` promises and `await Promise.all(...)` — each from the same
organisation, each with its own `invoiceId` (`'inv-contention-0'` … `'inv-contention-4'`) and
its own `Idempotency-Key`, each for `'10000'` USD.

Assert: every response is `201`; no response is `5xx`; and no response body's JSON text
mentions a serialization or deadlock failure. `src/treasury/retry/failure-classifier.ts`
treats Postgres `40001` and `40P01` as transient, so either code reaching a caller is the
defect this scenario catches — assert the stringified body contains neither `'40001'` nor
`'40P01'`.

Five is deliberate: enough to serialize on the row lock, far short of the thousand-request
storm in `test/integration/concurrency.spec.ts`, which FR-012 forbids duplicating. Record
that in a comment.

**Scenario 2 — exact resulting position.** In the same `it(...)` as scenario 1 or immediately
after against the same program, read `local_reserved_minor` back and assert it equals
`50000` — the exact sum of the five accepted reservations. No write lost, none
double-counted.

**Scenario 3 — mixed operations.** A fresh organisation and program. First, sequentially and
each asserted `201`, create three reservations: `'inv-mixed-release'` for `'100000'`,
`'inv-mixed-cancel'` for `'100000'`, and nothing else. Then issue **simultaneously**, via
`Promise.all`:
- a new reservation, `'inv-mixed-new'` for `'50000'`;
- a release against `'inv-mixed-release'` for `{ amountMinor: '40000', currency: 'USD' }`
  (`POST reservations/inv-mixed-release/releases`);
- a cancellation of `'inv-mixed-cancel'` (`POST reservations/inv-mixed-cancel/cancellation`,
  body `{ reason: 'CANCELLED' }`).

Assert each response is `201`, none is `5xx`, and no body mentions `40001` or `40P01`. Then
read `local_reserved_minor` back and assert it equals
`100000 + 100000 + 50000 - 40000 - 100000 = 110000`.

**Header comment.** At the head of the file, record what this suite deliberately does **not**
test and why: a genuine multi-program deadlock needs two transactions taking two programs in
opposite orders; `src/capacity/infrastructure/unit-of-work.ts` locks exactly one program per
transaction and every write route is mounted under `v1/programs/:programId`, so no supported
request can express it (R-006). FR-013 forbids simulating it below the API and presenting the
result as end-to-end evidence. Note the debt explicitly: a multi-program endpoint makes
deadlock coverage owed the day it lands.

#### Constraints

- Every request carries its own `Idempotency-Key`; a shared key turns a concurrent write into
  an idempotency replay and the scenario proves nothing.
- The write rate limit is 120 per minute (`RATE_LIMIT_WRITE_PER_MINUTE` set by the fixture);
  this file issues far fewer, but do not add retry loops that could approach it.
- Do not modify `test/integration/concurrency.spec.ts`.
- Assertions come only from HTTP responses and database row reads.

#### Edge Cases

- A `429` from any request means the rate limit was hit; that is a fixture defect, not a
  contention finding. Assert `201` specifically, so a `429` fails loudly.
- A cancellation with `reason: 'WRITTEN_OFF'` does **not** return capacity; this plan uses
  `'CANCELLED'`, which does. Do not substitute.

#### Verification

```bash
npm run test:e2e -- -t 'contention'
npm run typecheck
npm run lint
```

Expected:
- Both scenarios pass; the resulting positions are exactly `50000` and `110000`.

#### Completion Criteria

- [ ] Exactly five simultaneous reservations, all asserted `201`.
- [ ] The resulting `local_reserved_minor` asserted exactly.
- [ ] A mixed reservation/release/cancellation burst asserted, with its exact resulting position.
- [ ] No response body contains `40001` or `40P01`.
- [ ] The header comment records the multi-program deadlock as unreachable, with the debt noted.
- [ ] T017–T021 ticked in `tasks.md`.

---

### Task 7: Add the end-to-end step to the CI gate

#### Objective

`.github/workflows/ci.yml` runs `npm run test:e2e` in the existing `gate` job, with every
existing step untouched.

Covers `tasks.md` T022.

#### Files

- `.github/workflows/ci.yml` — MODIFY. One new step.
- `specs/004-e2e-api-tests/tasks.md` — MODIFY. Tick T022.

#### Implementation

Insert, between the `Coverage gate` step and the `Build` step of the `gate` job:

```yaml
      - name: Run end-to-end API tests
        run: npm run test:e2e
```

`gate` already runs on `ubuntu-latest`, which provides a Docker daemon, and already has
`timeout-minutes: 30`, which accommodates the suite's 5-minute budget (SC-004). No new
service, no new `timeout-minutes`, no new job.

#### Constraints

- Change no existing step's `name`, `run`, `uses` or order.
- Leave `.github/workflows/release-gates.yml` and `.github/workflows/mutation.yml`
  completely untouched — `mutation.yml` arrived with feature 003, merged as pull request #17.
- Do not add a second job; a path-filtered or separate job is not wanted here.

#### Edge Cases

- None. This is a single additive step.

#### Verification

```bash
git diff .github/workflows/
```

Expected:
- The diff shows exactly two added lines plus a blank separator in `ci.yml`, inside the
  `gate` job's `steps`, between `Coverage gate` and `Build`. `release-gates.yml` and
  `mutation.yml` do not appear in the diff.

#### Completion Criteria

- [ ] The new step exists, named `Run end-to-end API tests`, running `npm run test:e2e`.
- [ ] It sits after `Coverage gate` and before `Build`.
- [ ] No other workflow file changed.
- [ ] T022 ticked in `tasks.md`.

---

### Task 8: Record the four assumptions

#### Objective

`docs/ASSUMPTIONS.md` carries the four decisions this feature made that a later reader would
otherwise have to reconstruct.

Covers `tasks.md` T023.

#### Files

- `docs/ASSUMPTIONS.md` — MODIFY. Four appended `##` sections.
- `specs/004-e2e-api-tests/tasks.md` — MODIFY. Tick T023.

#### Implementation

Append four sections in the file's existing style — an `##` heading stating the decision as a
claim, then one or two paragraphs of prose giving the rationale. Match the surrounding tone;
do not use bullet lists.

1. **The scope cut.** The feature request named four concerns: overbooking, idempotency,
   deadlock and access control. Idempotency and access control were found already covered end
   to end — `test/integration/reserve-endpoint.spec.ts` asserts the exact replay returning
   `200` with an identical body, `403 INSUFFICIENT_SCOPE` for a token without
   `capacity:write`, and `404 NOT_FOUND` for another organisation's program, and the contract
   specs assert the same surface. Re-asserting them was rejected under FR-012. This is the
   feature's largest decision and the one most likely to be questioned later.

2. **The two unreachable cases, and the debt.** A multi-program deadlock cannot be provoked:
   `src/capacity/infrastructure/unit-of-work.ts` locks exactly one program per transaction
   and every write route is mounted under `v1/programs/:programId` (R-006). `INVALID_AMOUNT`
   cannot be observed over HTTP: `CreateReleaseDto.amount` is a `PositiveMoneyDto` whose
   `amountMinor` carries `@Matches(/^[1-9][0-9]{0,18}$/)`, so the `ValidationPipe` returns
   `400 VALIDATION_FAILED` before the domain guard runs (R-010). Both are recorded in the
   suite itself. The day a multi-program endpoint lands, deadlock coverage falls due.

3. **The suite is excluded from `npm test`, and a fourth Jest config is why.**
   `jest.config.ts` roots at `src` and `test` with `testRegex: '.*\.spec\.ts$'`, so any file
   under `test/` joins the default run and the 80% coverage gate automatically. Letting the
   end-to-end suite join would add several minutes of container start-up to every
   `npm test`, and its coverage contribution would move the gate's numbers without any
   change in `src/`. `jest.e2e.config.ts` plus one `testPathIgnorePatterns` entry is the
   mechanism the repository already uses for `test:recovery` and `test:perf`.

4. **A documentation inaccuracy was found and deliberately not fixed.**
   `src/capacity/api/capacity.controller.ts` documents the `400` response at lines 109, 224
   and 346 as `'VALIDATION_FAILED or INVALID_AMOUNT'`. A caller cannot observe the second,
   for the reason in entry 2. FR-010 forbids changing any production file to accommodate this
   suite, so the wording stands; it is recorded here instead.

#### Constraints

- Append only. Do not edit, reorder or reword any existing section.
- Do not change `src/capacity/api/capacity.controller.ts` to fix the inaccuracy in entry 4.

#### Edge Cases

- If `docs/ASSUMPTIONS.md` already carries a section on any of these, extend it rather than
  duplicating the heading.

#### Verification

```bash
npm run docs:verify
git diff --stat docs/
```

Expected:
- `docs:verify` passes.
- Only `docs/ASSUMPTIONS.md` appears in the `docs/` diff.

#### Completion Criteria

- [ ] Four new `##` sections exist, each with its rationale.
- [ ] No existing section changed.
- [ ] `npm run docs:verify` passes.
- [ ] T023 ticked in `tasks.md`.

---

### Task 9: Document the command in README.md and CLAUDE.md

#### Objective

A reader learns `npm run test:e2e` exists, what it covers, that it needs a container runtime,
and that it is deliberately outside `npm test`.

Covers `tasks.md` T028.

#### Files

- `README.md` — MODIFY. One bullet in the `## Testing` list.
- `CLAUDE.md` — MODIFY. One line in the Commands block.
- `specs/004-e2e-api-tests/tasks.md` — MODIFY. Tick T028.

#### Implementation

**This task depends on Task 1**, which adds the `test:e2e` script to `package.json`.
`test/unit/readme-references.spec.ts` asserts that every `npm run <name>` token in the README
names a script that exists, and that spec runs in both `npm test` and `npm run docs:verify`.
Naming the script before it exists turns both red. Before editing, confirm the dependency
holds:

```bash
grep -n '"test:e2e"' package.json
```

If that prints nothing, stop: Task 1 has not been completed.

1. In `README.md`, in the `## Testing` list, after the `npm run test:perf` bullet, add:
   ```markdown
   - `npm run test:e2e` — end-to-end API suite: capacity refusals, the overbooking boundary
     and single-program contention, driven over HTTP against the real application. Needs a
     Docker daemon. Deliberately excluded from `npm test`.
   ```

2. In `CLAUDE.md`, in the fenced Commands block, after the `npm run test:cov` line, add:
   ```
   npm run test:e2e             # end-to-end API suite over HTTP, needs Docker, not in `npm test`
   ```

A script entry in `package.json` alone does not satisfy "documented" — feature 003 shipped
`docs/testing-mutation.md` plus README links for the same reason.

#### Constraints

- Do not reword or reorder any existing bullet or command line.
- Do not add a `docs/` page for this feature; two lines is the right weight, and
  `specs/004-e2e-api-tests/quickstart.md` already holds the detail.
- FR-010's prohibition covers `src/` and production behaviour; the documentation required by
  FR-008 is explicitly what this task delivers.

#### Edge Cases

- `readme-references.spec.ts` also asserts every backticked path in the README exists. The
  bullet above contains no path, so nothing else needs to exist first.

#### Verification

```bash
npm run test:unit -- readme-references
npm run docs:verify
npm test
```

Expected:
- All three pass. In particular `readme-references.spec.ts` is green, which is the specific
  gate that would catch a README naming a nonexistent script.

#### Completion Criteria

- [ ] `README.md` names `npm run test:e2e` with its coverage, its Docker requirement and its
      exclusion from `npm test`.
- [ ] `CLAUDE.md`'s Commands block names it.
- [ ] `npm run docs:verify` passes.
- [ ] T028 ticked in `tasks.md`.

---

### Task 10: Prove the new assertions can fail, twice

#### Objective

The suite is observed failing — once for a real behaviour change in `src/`, once for a broken
assertion — and both probes are discarded.

Covers `tasks.md` T024 and T029. Depends on Task 5.

#### Files

- No file is committed by this task. Two scratch edits are made and reverted.
- `specs/004-e2e-api-tests/tasks.md` — MODIFY. Tick T024, T029.

#### Implementation

**Probe A — the gate detects a real behaviour change (SC-008, Constitution Principle VI).**

1. Confirm `git status --porcelain` is clean.
2. In `src/capacity/domain/policies/reserve.policy.ts`, change
   `if (reservedMinor > availableMinor)` to `if (reservedMinor >= availableMinor)`.
3. `npm run test:e2e`.
4. Confirm it exits **non-zero** and the output names the "exactly available" boundary
   scenario from `test/e2e/capacity-boundary.spec.ts` — the mutation makes a request for
   precisely the remaining amount fail, which is the one input that scenario pins.
5. `git checkout -- src/capacity/domain/policies/reserve.policy.ts` and confirm
   `git status --porcelain` shows no `src/` file.

**Probe B — the failure output is usable (FR-016).**

1. In `test/e2e/capacity-boundary.spec.ts`, in the `available + 1` scenario, change the
   expected status from `409` to `200`.
2. `npm run test:e2e -- -t 'boundary'` and capture the output.
3. Confirm the output names the failing scenario, **both** the expected and the actual
   status, **and** the response `code`. If `body.code` is absent from the printed output, the
   scenario asserts the status without asserting the code, Task 5 is incomplete, and the fix
   belongs in Task 5's file rather than here — report that and stop.
4. Revert the file and confirm `git status --porcelain` shows no change under `test/e2e/`.

Probe B is not ceremony. A bare `expect(response.status).toBe(409)` satisfies the letter of
FR-016 while printing no `code`, and the first person to hit a real failure is the one who
discovers it.

#### Constraints

- **Neither mutation is ever committed.** FR-010 forbids changing production behaviour; both
  are throwaway probes.
- Do not "fix" the suite to accommodate the mutated source in probe A — the failure is the
  expected result.
- Perform the probes on the working branch only if `git status --porcelain` is clean first,
  so the revert is unambiguous. Do not use `git stash` (the stash stack is shared across
  worktrees).

#### Edge Cases

- If probe A exits **zero**, the boundary scenario is not pinning the edge. That is a real
  defect in Task 5's work: report it with the exact command output and stop, rather than
  weakening the probe.
- If the working tree is not clean when the task starts, stop and report; a revert would
  otherwise discard someone else's change.

#### Verification

```bash
git status --porcelain
```

Expected:
- After both probes, no modification under `src/` or `test/e2e/`. Only
  `specs/004-e2e-api-tests/tasks.md` may differ, from ticking the two boxes.

#### Completion Criteria

- [ ] Probe A ran, exited non-zero, and named the boundary scenario.
- [ ] Probe B ran and its output carried the scenario name, both statuses and `body.code`.
- [ ] `git status --porcelain` shows no `src/` or `test/` modification afterwards.
- [ ] T024, T029 ticked in `tasks.md`.

---

### Task 11: Prove nothing else changed

#### Objective

Every pre-existing command behaves exactly as before, verified against the committed
baseline, and the suite's imports and scenarios are confirmed compliant by inspection.

Covers `tasks.md` T025 and T026. Depends on Tasks 1–9.

#### Files

- No production or test file changes. This task reads and reports.
- `specs/004-e2e-api-tests/tasks.md` — MODIFY. Tick T025, T026.

#### Implementation

**Part 1 — the isolation check (contract C-4).** Run, in order:

```bash
npm test
npm run test:unit
npm run test:cov
npm run test:recovery
npm run test:mutation
npm run typecheck
npm run lint
npm run build
npm run docs:verify
```

Read `specs/004-e2e-api-tests/baseline.md` — written by Task 1 before any file existed under
`test/e2e/` — and compare:

- `npm test` must report the **same** `Test Suites:` and `Tests:` counts as the baseline. If
  they grew, the `'test/e2e/'` entry in `jest.config.ts` `testPathIgnorePatterns` is missing
  and the end-to-end suite has joined the default run, breaching FR-011.
- `npm run test:cov` must report the **same** four percentages as the baseline.

Then confirm the untouched-file set:

```bash
git diff --stat jest.mutation.config.js stryker.config.mjs jest.recovery.config.ts jest.perf.config.ts package-lock.json
```

must print nothing.

**Part 2 — FR-012 by hand.** For every scenario added in Tasks 3–6, confirm no existing
end-to-end test already makes the same assertion. Check specifically
`test/integration/reserve-endpoint.spec.ts`, `test/integration/concurrency.spec.ts`,
`test/contract/reservations.contract.spec.ts`, `test/contract/releases.contract.spec.ts` and
`test/contract/auth-enumeration.contract.spec.ts`. Report any overlap found; a genuine
duplicate must be removed from the new suite, not from the existing one.

**Part 3 — FR-009.**

```bash
git diff --stat test/
```

must show only `test/e2e/refusals.spec.ts`, `test/e2e/capacity-boundary.spec.ts`,
`test/e2e/contention.spec.ts` and `test/support/e2e-app.ts`.

**Part 4 — FR-015 by inspection, not by lint.** `eslint.config.mjs` sets
`'boundaries/include': ['src/**/*.ts']`, so `eslint-plugin-boundaries` never evaluates a file
under `test/` and `npm run lint` passes whatever the suite imports. Read the import list of
each of the four new files and confirm every `src/` import is a module's public entry point
and that nothing reaches into a layer's internals to shortcut a scenario. The permitted
`src/` imports are exactly those the existing HTTP-level specs already use:
`src/app.module`, `src/shared/validation/create-validation-pipe`, and `src/config/data-source`
(for `dataSourceOptions`), plus `scripts/seed` constants if any are used. An import of
`src/capacity/application/*`, `src/capacity/domain/*` or `src/capacity/infrastructure/*` from
a `test/e2e/` file is a violation — report it and stop.

#### Constraints

- This task changes no file other than the task checkboxes. If a check fails, report the
  failure and the evidence; do not fix it here.
- `npm run test:perf` is deliberately **not** in the list: it is a release gate that takes
  far longer than the rest, and contract C-4 does not require it.

#### Edge Cases

- `npm run test:mutation` takes up to ten minutes and needs no Docker; a timeout is not a
  failure of this feature, but a non-zero exit **is** — report the score against the floor in
  `stryker.config.mjs`.
- If the baseline file is missing, stop: Task 1 was not completed and the comparison cannot
  be made.

#### Verification

The commands above are themselves the verification.

Expected:
- Every command exits zero.
- `npm test` counts and `npm run test:cov` percentages match `baseline.md` exactly.
- Both `git diff --stat` invocations produce the expected output.
- The import inspection finds no import outside the permitted set.

#### Completion Criteria

- [ ] All nine commands exit zero.
- [ ] `npm test` and `npm run test:cov` match the baseline exactly.
- [ ] `git diff --stat` on the five protected files prints nothing.
- [ ] `git diff --stat test/` shows only the four new files.
- [ ] No `test/e2e/` file imports from `src/capacity/**`.
- [ ] T025, T026 ticked in `tasks.md`.

---

### Task 12: Run the quickstart and record the timings

#### Objective

Every quickstart scenario passes in order and the two success-criterion timings are recorded.

Covers `tasks.md` T027. Depends on every prior task.

#### Files

- `specs/004-e2e-api-tests/tasks.md` — MODIFY. Tick T027 and confirm T001–T029 are all ticked.

#### Implementation

1. Run every scenario in `specs/004-e2e-api-tests/quickstart.md` in order, 1 through 7, plus
   the repository hygiene check at the end of that file. Each scenario states its own
   expected outcome; follow it literally.
2. Record the wall time of a full `npm run test:e2e` and confirm it is **under 5 minutes**
   (SC-004):
   ```bash
   time npm run test:e2e
   ```
3. Record the wall time of the boundary suite **excluding container start-up** and confirm it
   is **under 30 seconds** (SC-002). Jest's own per-suite time for
   `test/e2e/capacity-boundary.spec.ts` is the figure to use — not the `time` wall clock,
   which includes pulling and starting Postgres and Redis.
4. Report both figures in the completion message.

#### Constraints

- Do not edit `quickstart.md` to match what happened. If a scenario's expectation is not met,
  report the divergence with the exact output and stop.
- Do not commit any file the quickstart tells you to create on a scratch basis.

#### Edge Cases

- A cold container pull can dominate the first run. Run `npm run test:e2e` twice and use the
  second run's figures; state in the report that the first run was a cold pull.
- If SC-004 is exceeded, report the actual figure — do not reduce the scenario count to fit.

#### Verification

```bash
time npm run test:e2e
git status --porcelain
```

Expected:
- The suite passes; wall time under 5 minutes on a warm cache.
- `git status --porcelain` shows only the feature's intended files.

#### Completion Criteria

- [ ] All seven quickstart scenarios plus the hygiene check ran and met their stated expectations.
- [ ] Full-suite wall time recorded and under 5 minutes.
- [ ] Boundary per-suite time recorded and under 30 seconds.
- [ ] T027 ticked, and T001–T029 all ticked in `tasks.md`.

---

## Final Verification

1. Working tree contains exactly: `jest.e2e.config.ts`, `test/support/e2e-app.ts`,
   `test/e2e/{refusals,capacity-boundary,contention}.spec.ts`,
   `specs/004-e2e-api-tests/baseline.md`, plus modifications to `jest.config.ts`,
   `package.json`, `.github/workflows/ci.yml`, `docs/ASSUMPTIONS.md`, `README.md`,
   `CLAUDE.md` and `specs/004-e2e-api-tests/tasks.md`.
2. No file under `src/` is modified. `package-lock.json` diff is empty.
3. All 29 boxes in `specs/004-e2e-api-tests/tasks.md` are ticked.

Commands:

```bash
npm run lint
npm run typecheck
npm test
npm run test:cov
npm run test:e2e
npm run build
npm run docs:verify
git status --porcelain
git diff --stat src/ package-lock.json
```

Expected:
- Every command exits zero.
- `npm test` and `npm run test:cov` match `specs/004-e2e-api-tests/baseline.md`.
- `git diff --stat src/ package-lock.json` prints nothing.

## Executor Rules

1. Execute each task in a **separate sub-agent** with a fresh context; do not run multiple
   tasks inside one long-lived session.
2. Execute tasks strictly in numerical order.
3. Complete the current task and its verification before starting the next task.
4. Implement the solution described in the plan exactly.
5. Do not redesign architecture or substitute a different approach.
6. Do not add features, cleanup, abstractions, or refactors not explicitly required by the plan.
7. Do not omit planned behavior because another implementation appears simpler.
8. Do not reinterpret product requirements.
9. Do not make optional improvements.
10. Follow existing project conventions where the plan explicitly relies on them.
11. Run the verification specified for every task.
12. Mark a task complete only when its completion criteria are satisfied.
13. If implementation reveals information that does not affect the prescribed solution,
    continue execution.
14. Stop rather than improvise when the plan cannot be executed as written.

The executor may stop only for a concrete blocker such as: a referenced file, API, dependency
or subsystem does not exist; repository state materially contradicts facts the plan depends
on; a required credential or external resource is unavailable; the prescribed implementation
is technically impossible; executing the plan would require an architectural or product
decision not covered by the plan; two instructions in the plan directly contradict each
other; verification proves an assumption fundamental to the planned implementation is false.

When stopping, report: the task number; the exact blocker; the evidence establishing it;
which plan assumption is invalid; and the minimum planning decision required to continue.
