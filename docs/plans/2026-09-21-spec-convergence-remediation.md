# Execution Plan: Close the convergence findings across specs 001-004

## Goal

Every convergence finding raised against features 001-004 is either implemented and
verified, or recorded in `docs/ASSUMPTIONS.md` as a deliberate, reasoned non-build — with
no finding left in an undecided state, and no pre-existing gate changing its result.

## Current State

All four features are merged to `develop`. `/speckit-converge` appended convergence tasks
to each feature's `tasks.md`, and an audit of 002's checkboxes surfaced four further gaps
that converge did not raise. Facts established during planning:

- `src/auth/throttler.config.ts` declares exactly two throttlers, `read` and `write`, both
  `ttl: 60_000`, limits from `RATE_LIMIT_READ_PER_MINUTE` / `RATE_LIMIT_WRITE_PER_MINUTE`,
  storage `ThrottlerStorageRedisService`. Keyed per organisation. There is no per-program
  dimension anywhere in the file.
- `src/capacity/application/recovery-detection.service.ts` exports
  `RecoveryDetectionService` with `detect(): Promise<RecoveryDetectionReport>` where
  `RecoveryDetectionReport` is `{ readonly flagged: ReadonlyArray<string> }`. It runs
  `UPDATE program SET position_verified = FALSE WHERE id = $1` per flagged program and
  pushes the id onto `flagged`. The class has **no** `Logger` and imports nothing from
  `src/observability/metrics`.
- `src/capacity/application/reconciliation-check.service.ts` is the established pattern for
  exactly this: it imports `investigationRequiredPrograms` from `../../observability/metrics`
  and calls `investigationRequiredPrograms.set(mismatches.length)` once, after its loop,
  immediately before `return`.
- `src/observability/metrics.ts` declares gauges with `export let <name>: Gauge;` at module
  scope and assigns them inside `registerMetrics()` via
  `getOrCreate('<metric_name>', () => new Gauge({ name, help, registers: [metricsRegistry] }))`.
  Existing gauges: `consumer_lag_messages` (labelled `program_id`), `over_limit_programs`,
  `dlq_depth`, `investigation_required_programs`. `registerMetrics()` is called at the
  bottom of the module. `getOrCreate` makes registration idempotent across Jest workers.
- `src/capacity/api/capacity.controller.ts` carries three identical blocks reading
  `@ApiResponse({ status: 400, description: 'VALIDATION_FAILED or INVALID_AMOUNT', type: ErrorResponse })`
  — at lines 107-111, 222-226 and 344-348. A caller cannot observe `INVALID_AMOUNT`,
  because `CreateReleaseDto.amount` is a `PositiveMoneyDto` whose `amountMinor` carries
  `@Matches(/^[1-9][0-9]{0,18}$/)`, so the global `ValidationPipe` returns
  `400 VALIDATION_FAILED` before `releasePolicy` runs.
- `README.md` line 66 links `[open the UI](http://localhost:3000/docs)`, while line 56 of
  the same file correctly uses `http://localhost:$PORT/...`. `CLAUDE.md` states ports are
  per-worktree, karst-allocated in 4000-4100, and must never be hardcoded.
- `test/support/openapi.ts` compiles `Ajv2020` against the **hand-written 001 contract**
  `specs/001-program-capacity-reservation/contracts/http-api.yaml` and exposes
  `openapiValidator(schemaRef)`. It validates live responses against that contract. It does
  **not** validate the generated document against the OpenAPI 3.1 meta-schema, and no other
  file does.
- `test/unit/openapi-schemas.spec.ts` builds its document from a **minimal empty module**
  via `NestFactory` plus `buildOpenApiDocument` from `src/docs`, with no database. It is
  Docker-free. `test/contract/openapi-conformance.contract.spec.ts` builds the **real**
  document from `AppModule` and is therefore Docker-bound, starting Postgres and Redis.
- `scripts/verify-docs.sh` runs exactly four unit specs: `readme-references`,
  `openapi-schemas`, `openapi-metadata`, `docs-bootstrap`. It explicitly prints that
  `openapi-conformance.contract.spec.ts` is NOT asserted there because it needs Docker.
- `src/capacity/api/error.filter.ts` declares `const MESSAGES: Record<RefusalCode, string>`
  (module-private, **not** exported) and `export const REFUSAL_STATUS: Record<RefusalCode, number>`.
  `src/capacity/domain/errors.ts` exports `REFUSAL_CODES`.
- The `@ApiHeader({ name: 'Idempotency-Key', required: true, ... })` block in the controller
  carries a `description` and a schema with `minLength`/`maxLength`, but **no** `example`.
- `test/e2e/refusals.spec.ts` defines, inside its `describe` callback, three consts:
  `FORBIDDEN_BODY_KEYS = new Set(['stack', 'sql', 'query'])`, a recursive
  `collectLeakedKeys(value, path = '$'): string[]`, and
  `expectNoLeakedInternals(body: unknown): void` which asserts
  `expect(collectLeakedKeys(body)).toEqual([])`. Neither `test/e2e/capacity-boundary.spec.ts`
  nor `test/e2e/contention.spec.ts` has any equivalent.
- `test/support/e2e-app.ts` exports `E2eApp`, `startE2eApp`, `stopE2eApp`, `tokenFor`,
  `JWT_SECRET`, `WRITE_SCOPE`, `READ_SCOPE`. All three e2e specs already import from it.
- `test/integration/concurrency.spec.ts` sets `jest.setTimeout(300_000)`, drives
  `CONCURRENT_REQUESTS = 1_000` in a single `it(...)`, and asserts exactly 100 acceptances.
  It runs the storm **once**.
- `@seriousme/openapi-schema-validator` latest is `2.10.0`; its dependencies are
  `ajv ^8.20.0`, `ajv-formats ^3.0.1`, `yaml ^2.9.0`, `ajv-draft-04 ^1.0.0`. The repository
  already depends on `ajv` and `ajv-formats`. No OpenAPI meta-schema is vendored in
  `node_modules` today.

## Target State

- `docs/ASSUMPTIONS.md` carries three new entries recording deliberate non-builds, each
  with its rationale and the condition that would make the work fall due.
- `RecoveryDetectionService` emits one `Logger.warn` per newly flagged program and sets a
  new `position_unverified_programs` gauge, so an operator can see a program held pending a
  fresh snapshot.
- The controller's three `400` descriptions name only `VALIDATION_FAILED`.
- `README.md` links the docs UI through `$PORT`.
- A new Docker-free unit spec validates the generated OpenAPI document against the
  OpenAPI 3.1 meta-schema, and `scripts/verify-docs.sh` runs it.
- A new Docker-free unit spec asserts example completeness on every request DTO and
  response class, and the `Idempotency-Key` header declares an example.
- A new Docker-free unit spec asserts every `REFUSAL_CODES` entry has a `MESSAGES` string
  and a `REFUSAL_STATUS` status, and `scripts/verify-docs.sh` runs it.
- The FR-006 leak assertion covers all three e2e spec files, from one shared helper.
- Every convergence task that this plan completes is ticked in its `tasks.md`.

## Scope

### In Scope

- 001: T104, T105, T106
- 002: T067, T068, T069, T070, T071, and the audit-surfaced T009, T023, T038, T039, T041, T044, T051
- 004: T030
- One new devDependency, pinned.
- `docs/ASSUMPTIONS.md` entries for every deliberate non-build.

### Out of Scope

- Any change to database schema, migrations, or persisted data. Nothing in this plan writes
  a migration.
- Any change to `.github/workflows/ci.yml`, `release-gates.yml` or `mutation.yml`.
- Building per-program rate limiting (Key Decision 1 rejects it).
- Running the 1,000-request storm twenty times (Key Decision 2 rejects it).
- 002 T061, T062, T065, T066 — measurement and walkthrough tasks whose only honest artefact
  is a human's report. They stay unticked and are not addressed here.
- Marking 003 T034 ticked. It stays open until a docs-only pull request exists.

## Key Decisions

1. **FR-033 per-program fairness is NOT built; it is recorded as a trade-off (001 T104).**
   Building it means a third throttler keyed on `programId`, which changes the rate-limit
   behaviour every caller sees and needs a product answer on the limit. The harm it guards
   against is already bounded: `unit-of-work.ts` takes one program row lock per
   transaction, so a second writer waits rather than failing, and `test/e2e/contention.spec.ts`
   proves five simultaneous writers all receive `201` with an exact resulting position.
   What remains unbounded is latency under a hostile same-program flood, not correctness.
   Recording beats guessing a limit. The debt falls due the day a caller reports
   program-level latency starvation, or a multi-program endpoint lands.

2. **SC-001's "20 consecutive runs" is NOT automated; it is recorded as a deviation (001 T106).**
   `test/integration/concurrency.spec.ts` already carries `jest.setTimeout(300_000)` for a
   single 1,000-request storm. Twenty consecutive runs would put a single spec near an hour
   and would dominate every CI run for a property the deterministic boundary suite in
   `test/e2e/capacity-boundary.spec.ts` pins far more cheaply — it asserts the exact edge,
   one unit over, and capacity return. The storm answers "is there a race"; twenty storms
   answer "is the race flaky", at a cost the project should pay only once a flake is
   actually observed. Record the deviation and the trigger.

3. **The two-API-client import validation is NOT performed; it is recorded (002 T070/T045).**
   It requires a human driving Postman and Insomnia against a seeded instance. No agent can
   produce that artefact honestly. Task 5's meta-schema validation is the automatable part
   of the same guarantee — a document that satisfies the OpenAPI 3.1 meta-schema is one a
   conformant client can import — so record the residual manual step with its exact
   procedure rather than pretending it ran.

4. **OpenAPI 3.1 validity is checked with `@seriousme/openapi-schema-validator@2.10.0`,
   added as a devDependency.** The alternative was vendoring the OAS 3.1 meta-schema JSON
   into `test/support/` and driving it with the existing `Ajv2020`; rejected because the
   meta-schema is large, must be fetched from the network to be correct, and an executor
   cannot author it from memory. The package bundles every meta-schema offline, its
   dependencies (`ajv`, `ajv-formats`) are already in the tree, and it exposes a one-call
   API. Pin the exact version; do not use a range.

5. **The validity and example specs are UNIT specs built from a minimal empty module,
   not contract specs.** 002's `tasks.md` named `test/contract/openapi-validity.contract.spec.ts`
   and `test/contract/openapi-examples.contract.spec.ts`, but a `test/contract/` spec boots
   `AppModule` and therefore needs Docker, which puts it outside `scripts/verify-docs.sh` —
   the very gate that should catch a malformed document. `test/unit/openapi-schemas.spec.ts`
   proves a full document can be built from a minimal module with no database. Follow that
   precedent so `docs:verify` can run them. The task text's filename is superseded; the
   guarantee is not.

6. **The `400` descriptions are corrected in the controller, not merely documented.**
   The convergence finding is classified `contradicts`: the served document tells a caller
   about a code it can never receive. 004 declined this only because its own FR-010 forbade
   touching `src/`. 002 owns the generated document's accuracy and has no such constraint.
   Correct all three blocks and amend the ASSUMPTIONS entry that recorded the inaccuracy as
   deliberate, so the record does not contradict the code.

7. **The leak helper moves to `test/support/e2e-app.ts` and is exported.** All three e2e
   specs already import from that module, so no new import path is introduced and no
   boundary rule changes. Duplicating the helper into two more files was rejected: three
   copies of a recursive assertion drift.

## Execution Order

### Task 1: Record the three deliberate non-builds in ASSUMPTIONS.md

#### Objective

Put on record, with rationale and a falling-due condition, the three convergence findings
this plan deliberately does not build: FR-033 per-program fairness, SC-001 repeat
stability, and the manual two-client import validation.

#### Files

- `docs/ASSUMPTIONS.md` — MODIFIED. Append three new `##` sections at the end of the file.

#### Implementation

The file is a flat list of `## <claim>` sections, each followed by prose giving the
rationale. Match that shape exactly — no nested headings, no bullet-only sections. Append,
in this order, after the last existing section:

1. `## Per-program rate-limit fairness is not implemented, and the contention bound is the row lock`

   State: `src/auth/throttler.config.ts` declares two throttlers, `read` and `write`, both
   on a 60-second window and both keyed per organisation. FR-033's second clause — that one
   organisation must not deny service to another by monopolising contention on a single
   program — has no corresponding mechanism. State why it is not built: a third throttler
   keyed on `programId` changes the rate limit every caller experiences and requires a
   product decision on the limit value, and the correctness harm is already bounded because
   `src/capacity/infrastructure/unit-of-work.ts` takes one program row lock per transaction,
   so a competing writer waits rather than fails —
   `test/e2e/contention.spec.ts` proves five simultaneous writers all receive `201` and an
   exact resulting position. State precisely what is left unguarded: latency under a hostile
   same-program flood, not correctness, and not cross-organisation data exposure. State the
   falling-due condition: a reported case of program-level latency starvation, or the
   arrival of an endpoint accepting more than one program.

2. `## The concurrency storm is asserted once, not twenty times`

   State: SC-001 requires the 1,000-request result "in 100% of 20 consecutive runs";
   `test/integration/concurrency.spec.ts` drives it once, under `jest.setTimeout(300_000)`.
   State why: twenty consecutive runs put one spec near an hour and would dominate every CI
   run. State what covers the property more cheaply:
   `test/e2e/capacity-boundary.spec.ts` pins the boundary deterministically at the exact
   edge, one minor unit over, and after a release — which is where an off-by-one actually
   shows. State what the deviation costs: a genuinely flaky race would be caught late, on a
   developer's run rather than by the gate. State the falling-due condition: the first
   observed flake in the storm spec makes the repeat harness owed immediately.

3. `## The exported document has not been imported into two API clients by hand`

   State: SC-003 and 002's US2 scenarios 2 and 3 require the exported document to import
   cleanly into two mainstream API clients, with every operation runnable and one
   collection-level bearer token authorising all of them. No artefact in the repository
   evidences this. State why it is not automated: it requires a human driving two GUI
   clients against a seeded instance. State what IS automated in its place:
   `test/unit/openapi-validity.spec.ts` validates the generated document against the
   OpenAPI 3.1 meta-schema, and a document satisfying that meta-schema is one a conformant
   client can parse. State the residual manual procedure verbatim so whoever runs it knows
   the bar: run `npm run openapi:export`, import the result into two clients, confirm zero
   import errors, confirm every operation appears as a runnable request, set the bearer
   token once at collection level and confirm it authorises all of them, then execute
   `getAvailability` and `createReservation` against a seeded instance with no hand-editing
   of any request.

#### Constraints

- Do not modify or delete any existing section of `docs/ASSUMPTIONS.md`.
- Do not change any source file in this task.
- Do not tick any checkbox in any `tasks.md` in this task.
- Write prose, not bullet lists, matching the surrounding sections' voice.

#### Edge Cases

- If a section with one of these three headings already exists, do not add a duplicate:
  update that section's body to the text described above and leave its heading as found.

#### Verification

```bash
cd /Users/nd/Work/projects/invoice-reservation
grep -c '^## ' docs/ASSUMPTIONS.md
npm run docs:verify
```

Expected:
- The `## ` count is exactly three higher than before the edit.
- `docs:verify` prints `verify-docs: PASS`.

#### Completion Criteria

- [ ] Three new `##` sections exist at the end of `docs/ASSUMPTIONS.md`.
- [ ] Each names its rationale and its falling-due condition.
- [ ] No pre-existing section was altered.
- [ ] `npm run docs:verify` exits zero.

---

### Task 2: Make the recovery hold observable

#### Objective

`RecoveryDetectionService` currently clears `position_verified` silently. Make every newly
flagged program produce a log line and a gauge reading, so an operator can see that a
program is refusing writes and why.

#### Files

- `src/observability/metrics.ts` — MODIFIED. Declare and register one new gauge.
- `src/capacity/application/recovery-detection.service.ts` — MODIFIED. Add a `Logger`, set
  the gauge.
- `test/unit/recovery-detection-observability.spec.ts` — CREATED. Asserts the gauge value.

#### Implementation

In `src/observability/metrics.ts`:

1. Beside the existing `export let investigationRequiredPrograms: Gauge;` declaration, add
   `export let positionUnverifiedPrograms: Gauge;`.
2. Inside `registerMetrics()`, directly after the `investigationRequiredPrograms` block,
   add:

   ```ts
   positionUnverifiedPrograms = getOrCreate(
     'position_unverified_programs',
     () =>
       new Gauge({
         name: 'position_unverified_programs',
         help: 'Programs held unverified pending a fresh treasury snapshot.',
         registers: [metricsRegistry],
       }),
   );
   ```

   Place it before the `collectDefaultMetrics` block at the end of the function.

In `src/capacity/application/recovery-detection.service.ts`:

3. Change the `@nestjs/common` import to `import { Injectable, Logger, OnModuleInit } from '@nestjs/common';`.
4. Add `import { positionUnverifiedPrograms } from '../../observability/metrics';`.
5. As the first member of the class, add
   `private readonly logger = new Logger(RecoveryDetectionService.name);`.
6. Inside `detect()`, immediately after `flagged.push(row.program_id);`, add:

   ```ts
   this.logger.warn(
     `program ${row.program_id} held unverified: stream position is behind its newest treasury ledger entry; writes are refused until a fresh snapshot clears it`,
   );
   ```

7. Immediately before `return { flagged };`, add
   `positionUnverifiedPrograms.set(flagged.length);`.

   This mirrors `src/capacity/application/reconciliation-check.service.ts`, which calls
   `investigationRequiredPrograms.set(mismatches.length)` once after its loop.

In `test/unit/recovery-detection-observability.spec.ts`, create a Docker-free unit spec:

8. Import `RecoveryDetectionService` from `../../src/capacity/application/recovery-detection.service`,
   and `positionUnverifiedPrograms`, `registerMetrics`, `resetMetrics` from
   `../../src/observability/metrics`.
9. Build a fake `DataSource` whose `query` method is a `jest.fn()`. The service calls
   `query` twice in two shapes: first the `SELECT p.id AS program_id, ...` sweep returning
   an array of `{ program_id, ledger_at, position_at }`, then one
   `UPDATE program SET position_verified = FALSE WHERE id = $1` per flagged row. Implement
   the fake by inspecting the SQL string: when it starts with `SELECT`, return the fixture
   rows; otherwise return `[]`. Cast the fake with
   `as unknown as DataSource` — do not construct a real `DataSource`.
10. Call `registerMetrics()` then `resetMetrics()` in `beforeEach` so the gauge starts at a
    known value.
11. Write three test cases:
    - **Two programs behind their ledger are both flagged and counted.** Fixture: two rows,
      each with a `ledger_at` of `new Date('2026-01-02T00:00:00.000Z')` and a `position_at`
      of `new Date('2026-01-01T00:00:00.000Z')`. Assert the returned `flagged` has length 2
      and that reading the gauge yields `2`. Read it with
      `await positionUnverifiedPrograms.get()` and assert
      `result.values[0]?.value` is `2`.
    - **A program whose position is current is not flagged and the gauge reads zero.**
      Fixture: one row with `position_at` equal to `ledger_at`. Assert `flagged` is empty
      and the gauge value is `0`. This is the regression case that matters: the gauge must
      be set on every sweep, not only when something is flagged, or a cleared condition
      would read stale forever.
    - **A program with no treasury ledger entry is skipped.** Fixture: one row with
      `ledger_at: null`. Assert `flagged` is empty and the gauge value is `0`.

#### Constraints

- Do not change the SQL in `detect()`. The query, its `WHERE p.position_verified = TRUE`
  filter, its `actor = 'treasury'` restriction and its `ORDER BY p.id ASC` stay exactly as
  they are.
- Do not change the `RecoveryDetectionReport` interface or `detect()`'s return value.
- Do not add a label to the new gauge. `investigation_required_programs` and
  `over_limit_programs` are both unlabelled counts; match them. A `program_id` label on a
  gauge with unbounded cardinality is a metrics defect.
- Do not write a migration. This task touches no schema.
- Do not use `console.log`; use the Nest `Logger` as every other service in the tree does.

#### Edge Cases

- **No programs flagged.** `positionUnverifiedPrograms.set(0)` must still run, so a
  previously non-zero gauge returns to zero once the condition clears. This is why the
  `set` call sits before `return`, outside the loop, not inside it.
- **`onModuleInit` runs `detect()` at boot.** The gauge is therefore set once at startup
  even when nothing is flagged. That is intended.
- **Repeated module import in one Jest worker.** `getOrCreate` already guards duplicate
  registration; do not add your own guard.

#### Verification

```bash
cd /Users/nd/Work/projects/invoice-reservation
npx jest test/unit/recovery-detection-observability.spec.ts
npm run typecheck
npm run lint
```

Expected:
- The new spec reports 3 passing tests.
- `typecheck` and `lint` both exit zero.

#### Completion Criteria

- [ ] `position_unverified_programs` is declared and registered in `src/observability/metrics.ts`.
- [ ] `RecoveryDetectionService` has a `Logger` and warns once per flagged program.
- [ ] `positionUnverifiedPrograms.set(flagged.length)` runs on every sweep, before `return`.
- [ ] `test/unit/recovery-detection-observability.spec.ts` passes with 3 tests.
- [ ] `npm run typecheck` and `npm run lint` exit zero.

---

### Task 3: Correct the 400 response description and amend its ASSUMPTIONS entry

#### Objective

The served document tells callers a `400` may carry `INVALID_AMOUNT`, which no caller can
ever receive. Correct all three occurrences and bring the ASSUMPTIONS record in line.

#### Files

- `src/capacity/api/capacity.controller.ts` — MODIFIED. Three `@ApiResponse` descriptions.
- `docs/ASSUMPTIONS.md` — MODIFIED. One existing section amended.

#### Implementation

1. In `src/capacity/api/capacity.controller.ts`, there are exactly three blocks reading:

   ```ts
   @ApiResponse({
     status: 400,
     description: 'VALIDATION_FAILED or INVALID_AMOUNT',
     type: ErrorResponse,
   })
   ```

   They sit at approximately lines 107-111, 222-226 and 344-348 — on the reserve, release
   and cancellation operations respectively. Change the `description` in **all three** to
   exactly `'VALIDATION_FAILED'`. Change nothing else in those blocks: `status`, `type` and
   the decorator order stay as they are.

2. In `docs/ASSUMPTIONS.md`, find the existing section whose heading is
   `## The `400` response names a refusal code a caller cannot observe`. Its body currently
   records the inaccuracy as found-and-deliberately-not-fixed. Rewrite the body to record
   that it **has now been fixed**: the three descriptions now read `VALIDATION_FAILED`
   alone; `INVALID_AMOUNT` remains a real refusal code in `REFUSAL_CODES` raised by
   `releasePolicy`, but it is unreachable over HTTP because `CreateReleaseDto.amount` is a
   `PositiveMoneyDto` whose `amountMinor` carries `@Matches(/^[1-9][0-9]{0,18}$/)`, so the
   global `ValidationPipe` returns `400 VALIDATION_FAILED` before the domain guard runs.
   Keep the heading text as found; only the body changes.

#### Constraints

- Do not remove `INVALID_AMOUNT` from `src/capacity/domain/errors.ts` `REFUSAL_CODES`, from
  `MESSAGES`, or from `REFUSAL_STATUS`. The code is still raised by `releasePolicy` and is
  reachable at the domain layer; only its HTTP documentation was wrong.
- Do not change `CreateReleaseDto`, `PositiveMoneyDto` or the validation pipe.
- Do not touch `test/e2e/refusals.spec.ts`, whose header comment explains the same
  unreachability — that comment stays correct and must not be edited.
- Do not change any other `@ApiResponse` description in the controller.

#### Edge Cases

- **A fourth occurrence exists.** Search the whole file for `INVALID_AMOUNT` before
  finishing. If more than three `@ApiResponse` descriptions mention it, correct every one.
  If any occurrence is outside an `@ApiResponse` description, leave it and report it.
- **The conformance spec compares against the 001 contract oracle.** If
  `specs/001-program-capacity-reservation/contracts/http-api.yaml` also states
  `VALIDATION_FAILED or INVALID_AMOUNT` for these operations and the conformance spec
  compares descriptions, the spec may fail. It compares status codes and schemas, not
  free-text descriptions, so this is not expected — but if it does fail on a description
  mismatch, stop and report rather than editing the 001 contract, which is the oracle.

#### Verification

```bash
cd /Users/nd/Work/projects/invoice-reservation
grep -n 'INVALID_AMOUNT' src/capacity/api/capacity.controller.ts
npx jest test/unit/openapi-metadata.spec.ts test/unit/openapi-schemas.spec.ts
npm run typecheck
npm run docs:verify
```

Expected:
- The `grep` prints nothing.
- Both unit specs pass.
- `typecheck` exits zero and `docs:verify` prints `verify-docs: PASS`.

#### Completion Criteria

- [ ] No occurrence of `INVALID_AMOUNT` remains in `src/capacity/api/capacity.controller.ts`.
- [ ] All three `400` descriptions read exactly `VALIDATION_FAILED`.
- [ ] The ASSUMPTIONS section records the fix rather than the deferral.
- [ ] `npm run docs:verify` exits zero.

---

### Task 4: Link the docs UI through $PORT in README.md

#### Objective

`README.md` links a hardcoded `http://localhost:3000/docs` while the same file and
`CLAUDE.md` state that ports are per-worktree and must never be assumed.

#### Files

- `README.md` — MODIFIED. One link on line 66.

#### Implementation

1. Line 66 currently reads, as part of the documentation paragraph:
   `([open the UI](http://localhost:3000/docs)).`
2. Replace the hardcoded host with the same form line 56 already uses, which is
   `http://localhost:$PORT/...`. A markdown link target cannot expand a shell variable, so
   do not leave it as a clickable link to a literal `$PORT`. Replace the parenthetical with
   inline code naming the URL to open:
   `(open `http://localhost:$PORT/docs`; `./scripts/dev-stack.sh env` prints the resolved
   port).`
3. Make no other change to the paragraph. The sentence naming `/docs`, `/docs/openapi.json`
   and `/docs/openapi.yaml` on lines 64-65 stays as it is.

#### Constraints

- Do not change line 56, which is already correct.
- Do not add a new README section or reorder existing ones.
- `test/unit/readme-references.spec.ts` asserts that every backticked path in the README
  exists on disk and that every `npm run <name>` token names a real script. The inserted
  backticked text is a URL, not a path — confirm the spec still passes rather than assuming
  it does.

#### Edge Cases

- **`readme-references.spec.ts` treats the backticked URL as a path and fails.** If it
  does, use plain text without backticks for the URL instead of inline code, keeping the
  same wording. Do not weaken or edit the spec.
- **Another hardcoded `localhost:3000` exists elsewhere in the README.** Search the whole
  file. Correct every occurrence the same way. Leave occurrences in `CLAUDE.md` alone —
  they are out of this task's scope and none is known to exist.

#### Verification

```bash
cd /Users/nd/Work/projects/invoice-reservation
grep -n 'localhost:3000' README.md
npx jest test/unit/readme-references.spec.ts
npm run docs:verify
```

Expected:
- The `grep` prints nothing.
- `readme-references.spec.ts` passes.
- `docs:verify` prints `verify-docs: PASS`.

#### Completion Criteria

- [ ] No occurrence of `localhost:3000` remains in `README.md`.
- [ ] The docs paragraph names `$PORT` and points at `./scripts/dev-stack.sh env`.
- [ ] `npx jest test/unit/readme-references.spec.ts` passes.

---

### Task 5: Validate the generated document against the OpenAPI 3.1 meta-schema

#### Objective

Nothing validates the generated document against the OpenAPI 3.1 meta-schema today. Add a
Docker-free unit spec that does, and wire it into the documentation gate. This is the
highest-severity convergence finding.

#### Files

- `package.json` — MODIFIED. One devDependency.
- `package-lock.json` — MODIFIED. Resolved by `npm install`.
- `test/unit/openapi-validity.spec.ts` — CREATED. The meta-schema assertion.
- `scripts/verify-docs.sh` — MODIFIED. One spec added to the `npx jest` list.

#### Implementation

1. Add the dependency, pinned exactly:

   ```bash
   npm install --save-exact --save-dev @seriousme/openapi-schema-validator@2.10.0
   ```

   Its transitive dependencies are `ajv`, `ajv-formats`, `yaml` and `ajv-draft-04`; the
   first two are already in the tree. Both `package.json` and `package-lock.json` must be
   committed together, because CI installs with `npm ci`, which fails when they disagree.

2. Create `test/unit/openapi-validity.spec.ts`. Build the document exactly the way
   `test/unit/openapi-schemas.spec.ts` does — that file is the working precedent for
   producing a full document with no database:
   - `import { Module } from '@nestjs/common';`, `import { NestFactory } from '@nestjs/core';`,
     `import type { INestApplication } from '@nestjs/common';`,
     `import type { OpenAPIObject } from '@nestjs/swagger';`
   - `import { buildOpenApiDocument } from '../../src/docs';`
   - Read `test/unit/openapi-schemas.spec.ts` first and copy its module-construction and
     teardown block verbatim, including which controllers and response classes it registers.
     Do not invent a different construction.
3. Import the validator: `import { Validator } from '@seriousme/openapi-schema-validator';`
4. In a single `it('the generated document satisfies the OpenAPI 3.1 meta-schema')`:
   - Build the document into a `const document: OpenAPIObject`.
   - Assert `document.openapi` starts with `'3.1'`. If it does not, the rest of the test is
     validating against the wrong dialect and the failure message must say so.
   - Run `const result = await new Validator().validate(document);`
   - Assert `result.valid` is `true`. On failure, include `JSON.stringify(result.errors, null, 2)`
     in the assertion message so the failing keyword and instance path are printed — a bare
     `expect(result.valid).toBe(true)` tells a reader nothing about which part of the
     document is malformed, and this spec exists to be read at the moment it fails.
5. In `scripts/verify-docs.sh`, section 2 runs:

   ```bash
   npx jest \
     test/unit/readme-references.spec.ts \
     test/unit/openapi-schemas.spec.ts \
     test/unit/openapi-metadata.spec.ts \
     test/unit/docs-bootstrap.spec.ts >/dev/null 2>&1 \
     || fail "documentation unit specs failed"
   ```

   Add `test/unit/openapi-validity.spec.ts` to that list, as the last entry before the
   redirect. Change nothing else in the script — not the `fail` message, not the other
   sections, not the closing "NOT asserted here" block.

#### Constraints

- Use `--save-exact`. A caret range on a validator lets a future patch change the gate's
  verdict without a commit.
- Do not add the package to `dependencies`; it is `devDependencies` only.
- Do not create the spec under `test/contract/`. A contract spec boots `AppModule`, needs
  Docker, and therefore cannot run inside `scripts/verify-docs.sh` — which is the gate that
  must catch a malformed document. 002's `tasks.md` T038 names a contract path; that
  filename is superseded by this plan, the guarantee is not.
- Do not modify `test/support/openapi.ts`. It validates live responses against the
  hand-written 001 contract and serves a different purpose.
- Do not change `jest.config.ts`. A spec under `test/unit/` is already matched by
  `testRegex` and joins `npm test` and the coverage run, which is intended here.

#### Edge Cases

- **`buildOpenApiDocument` emits `openapi: '3.0.x'`.** Then the meta-schema check is
  validating the wrong dialect. Stop and report; do not silently validate against 3.0.
- **The validator rejects a document Nest generated.** That is a true finding, not a test
  defect. Report the failing instance paths. Do not add exclusions to make it pass and do
  not weaken the assertion.
- **`npm install` cannot reach the network.** Stop and report; do not vendor a partial
  meta-schema by hand as a substitute.

#### Verification

```bash
cd /Users/nd/Work/projects/invoice-reservation
npx jest test/unit/openapi-validity.spec.ts
npm run docs:verify
npm run typecheck
git diff --stat package.json package-lock.json
```

Expected:
- The new spec passes.
- `docs:verify` prints `verify-docs: PASS`, and its "documentation unit specs" line still
  prints `ok`.
- `typecheck` exits zero.
- Both `package.json` and `package-lock.json` show as modified.

#### Completion Criteria

- [ ] `@seriousme/openapi-schema-validator` is a devDependency pinned to `2.10.0` with no range prefix.
- [ ] `package-lock.json` is updated in the same change.
- [ ] `test/unit/openapi-validity.spec.ts` exists, builds the document from a minimal module, and asserts meta-schema validity.
- [ ] Its failure message prints the validator's errors.
- [ ] `scripts/verify-docs.sh` runs the new spec.
- [ ] `npm run docs:verify` exits zero.

---

### Task 6: Enforce example completeness and declare the Idempotency-Key example

#### Objective

Examples exist on the response and request classes but nothing enforces that they stay
complete, and the required `Idempotency-Key` header declares no example at all.

#### Files

- `src/capacity/api/capacity.controller.ts` — MODIFIED. Add an `example` to the
  `Idempotency-Key` `@ApiHeader` on every operation that declares it.
- `test/unit/openapi-examples.spec.ts` — CREATED. Enforces completeness.
- `scripts/verify-docs.sh` — MODIFIED. One spec added to the `npx jest` list.

#### Implementation

1. In `src/capacity/api/capacity.controller.ts`, every `@ApiHeader({ name: 'Idempotency-Key', required: true, ... })`
   block carries a `description` and a `schema` with `minLength` and `maxLength`, but no
   example. Add `example: '7c9e6679-7425-40de-944b-e07fc1f90ae7'` to the `schema` object of
   **every** such block. Use that same value in all of them — one canonical example reads
   as a UUID and is obviously a placeholder.
2. Create `test/unit/openapi-examples.spec.ts`, building the document exactly as
   `test/unit/openapi-schemas.spec.ts` does — read that file first and copy its module
   construction verbatim.
3. Assert three properties, each as its own `it`:
   - **Every schema property under `components.schemas` that is a leaf carries an `example`.**
     Walk `document.components.schemas`. For each schema, for each entry of its
     `properties`, a property is a leaf when it has no `$ref` and its type is not `object`
     or `array`. Assert every leaf declares `example`. Collect all violations into an array
     of `"<SchemaName>.<propertyName>"` strings and assert that array equals `[]`, so one
     run names every offender rather than stopping at the first.
   - **Every required header parameter declares an example.** Walk every operation under
     `document.paths`; for each parameter with `in: 'header'` and `required: true`, assert
     its `schema.example` is a non-empty string. Collect violations as
     `"<method> <path> <headerName>"` and assert the array is empty. This is the assertion
     that pins the `Idempotency-Key` example added in step 1.
   - **Every request body schema resolves and carries at least one example.** For each
     operation with a `requestBody`, resolve its `application/json` schema `$ref` against
     `components.schemas` and assert the resolved schema has at least one property carrying
     an `example`. Collect violations as `"<method> <path>"` and assert empty.
4. Add `test/unit/openapi-examples.spec.ts` to the `npx jest` list in section 2 of
   `scripts/verify-docs.sh`, after the entry added by Task 5. Change nothing else in the
   script.

#### Constraints

- Do not add an `example` to a money `amountMinor` field that contradicts Principle I.
  Every monetary example must be a **decimal string in minor units**, never a number and
  never a decimal fraction. `test/unit/openapi-schemas.spec.ts` already asserts money
  typing; if an example you add breaks it, the example is wrong, not that spec.
- Do not change any existing `example` value that is already present and correct.
- Do not create the spec under `test/contract/`, for the reason given in Task 5.
- Do not modify `test/unit/openapi-schemas.spec.ts`.

#### Edge Cases

- **A leaf property legitimately has no useful example**, such as an opaque `nextCursor`.
  Give it an example anyway — an opaque token's example demonstrates its shape, which is
  exactly what a reader needs. Do not add an exclusion list to the spec; an exclusion list
  is how this assertion rots.
- **A schema property is `nullable` via `type: ['string', 'null']`.** Treat it as a leaf and
  require an example.
- **The walk finds a `$ref` cycle.** Track visited schema names and do not recurse into one
  twice.

#### Verification

```bash
cd /Users/nd/Work/projects/invoice-reservation
npx jest test/unit/openapi-examples.spec.ts test/unit/openapi-schemas.spec.ts
npm run docs:verify
npm run typecheck
npm run lint
```

Expected:
- Both specs pass; the examples spec reports 3 passing tests.
- `docs:verify` prints `verify-docs: PASS`.
- `typecheck` and `lint` exit zero.

#### Completion Criteria

- [ ] Every `Idempotency-Key` `@ApiHeader` schema declares `example: '7c9e6679-7425-40de-944b-e07fc1f90ae7'`.
- [ ] `test/unit/openapi-examples.spec.ts` exists and asserts all three properties, each collecting every violation.
- [ ] `scripts/verify-docs.sh` runs it.
- [ ] `npm run docs:verify` and `npm run typecheck` exit zero.

---

### Task 7: Assert the refusal-code table is complete, without Docker

#### Objective

Every refusal code must have a caller-facing message and an HTTP status. That assertion
exists only inside the Docker-bound conformance spec today, so `npm run docs:verify` cannot
catch a code added without either.

#### Files

- `src/capacity/api/error.filter.ts` — MODIFIED. Export the existing `MESSAGES` constant.
- `test/unit/openapi-error-codes.spec.ts` — CREATED. The completeness assertion.
- `scripts/verify-docs.sh` — MODIFIED. One spec added to the `npx jest` list.

#### Implementation

1. In `src/capacity/api/error.filter.ts`, line 15 declares
   `const MESSAGES: Record<RefusalCode, string> = {`. Change `const` to `export const`.
   That is the only change to this file: do not alter any message string, do not reorder
   entries, and do not touch `REFUSAL_STATUS`, which is already exported.
2. Create `test/unit/openapi-error-codes.spec.ts`. It needs no Nest application and no
   document — it asserts over three plain constants:
   - `import { REFUSAL_CODES } from '../../src/capacity/domain/errors';`
   - `import { MESSAGES, REFUSAL_STATUS } from '../../src/capacity/api/error.filter';`
3. Write four test cases:
   - **Every refusal code has a message.** Assert
     `REFUSAL_CODES.filter((code) => MESSAGES[code] === undefined)` equals `[]`.
   - **Every refusal code has a status.** Assert
     `REFUSAL_CODES.filter((code) => REFUSAL_STATUS[code] === undefined)` equals `[]`.
   - **No message is empty or whitespace-only.** Assert
     `REFUSAL_CODES.filter((code) => MESSAGES[code].trim() === '')` equals `[]`.
   - **Every status is a client or server error in the 4xx/5xx range.** Assert every
     `REFUSAL_STATUS[code]` is an integer `>= 400` and `< 600`. A refusal mapped to `200`
     would make a refusal indistinguishable from success.
   - **No message leaks internals.** Assert no message matches `/\b(select|insert|update|delete|from where)\b/i`
     and none contains the substring `Error:`. This is the unit-level counterpart of the
     e2e leak assertion in Task 8.
4. Add `test/unit/openapi-error-codes.spec.ts` to the `npx jest` list in section 2 of
   `scripts/verify-docs.sh`, after the entry added by Task 6. Change nothing else.

#### Constraints

- Export `MESSAGES`; do not duplicate the table into the test. A copy in the test asserts
  that the copy is complete, which proves nothing.
- Do not change `REFUSAL_CODES` in `src/capacity/domain/errors.ts`.
- Do not change any status in `REFUSAL_STATUS`.
- Do not create the spec under `test/contract/`, for the reason given in Task 5.
- Do not modify `test/contract/openapi-conformance.contract.spec.ts`, which asserts the same
  property behind Docker. The duplication is deliberate: this spec runs in the gate that has
  no Docker.

#### Edge Cases

- **`RefusalCode` is a union derived from `REFUSAL_CODES`,** so TypeScript may consider the
  `undefined` checks unreachable and `lint` may flag them as unnecessary conditions. Keep
  the runtime assertions — the risk being guarded is a `MESSAGES` entry deleted at runtime,
  which the type system will not catch once the object is cast. If the `no-unnecessary-condition`
  rule fires, index through a locally-typed `Record<string, string | undefined>` view of the
  constant rather than disabling the rule.
- **A code exists in `MESSAGES` but not in `REFUSAL_CODES`.** Assert that direction too:
  every key of `MESSAGES` appears in `REFUSAL_CODES`. A stale entry is dead documentation.

#### Verification

```bash
cd /Users/nd/Work/projects/invoice-reservation
npx jest test/unit/openapi-error-codes.spec.ts
npm run docs:verify
npm run typecheck
npm run lint
```

Expected:
- The new spec passes with 5 or more tests.
- `docs:verify` prints `verify-docs: PASS`.
- `typecheck` and `lint` exit zero.

#### Completion Criteria

- [ ] `MESSAGES` is exported from `src/capacity/api/error.filter.ts` with no other change to that file.
- [ ] `test/unit/openapi-error-codes.spec.ts` exists and asserts message presence, status presence, non-empty messages, 4xx/5xx statuses, no leaked internals, and no stale `MESSAGES` key.
- [ ] `scripts/verify-docs.sh` runs it.
- [ ] `npm run docs:verify` exits zero.

---

### Task 8: Extend the FR-006 leak assertion to all three e2e specs

#### Objective

`test/e2e/refusals.spec.ts` asserts that no response body carries a `stack`, `sql` or
`query` key at any depth. FR-006 binds every body the suite asserts, and the boundary and
contention specs assert bodies without that check.

#### Files

- `test/support/e2e-app.ts` — MODIFIED. Export the helper.
- `test/e2e/refusals.spec.ts` — MODIFIED. Import the helper, drop the local copy.
- `test/e2e/capacity-boundary.spec.ts` — MODIFIED. Import and call it.
- `test/e2e/contention.spec.ts` — MODIFIED. Import and call it.

#### Implementation

1. `test/e2e/refusals.spec.ts` defines three things inside its `describe` callback, at
   roughly lines 71-97:

   ```ts
   const FORBIDDEN_BODY_KEYS = new Set(['stack', 'sql', 'query']);

   const collectLeakedKeys = (value: unknown, path = '$'): string[] => { /* recursive */ };

   const expectNoLeakedInternals = (body: unknown): void => {
     expect(collectLeakedKeys(body)).toEqual([]);
   };
   ```

   Move all three to `test/support/e2e-app.ts` at module scope. Export
   `expectNoLeakedInternals` and `collectLeakedKeys`; keep `FORBIDDEN_BODY_KEYS`
   module-private. Copy the recursive body **verbatim** — it already handles arrays, null,
   non-objects, and nested keys, and builds a `$.a.b` path string for the failure message.
   Do not reimplement it.

   `expectNoLeakedInternals` calls `expect`, which is available in any file Jest loads;
   `test/support/e2e-app.ts` is only ever imported by specs, so this is safe. Add no
   `import { expect } from '@jest/globals'` unless `typecheck` demands it.

2. In `test/e2e/refusals.spec.ts`, delete the three local definitions and add
   `expectNoLeakedInternals` to the existing named import from `../support/e2e-app`. The six
   existing call sites keep working unchanged — do not touch them, and do not remove the
   `Contract F-5.5` comment; move it to the helper's new home in `e2e-app.ts`.

3. In `test/e2e/capacity-boundary.spec.ts`, add `expectNoLeakedInternals` to the existing
   named import from `../support/e2e-app`, then call it on **every** asserted response body
   in all three tests — the `201` from the exactly-available scenario, the `409` from the
   one-over scenario (whose body carries `details.requestedMinor` and
   `details.availableMinor`), the release response and the reservation response in the
   capacity-returns scenario. Place each call immediately after the existing status
   assertion for that response.

4. In `test/e2e/contention.spec.ts`, add the same import, then call
   `expectNoLeakedInternals` on every response body in both tests. The five simultaneous
   reservations arrive as an array — iterate it and call the helper on each body. The mixed
   reservation/release/cancellation burst likewise. Leave the existing
   `expect(text).not.toContain('40001')` and `'40P01'` assertions exactly as they are; they
   check a different property and both must remain.

#### Constraints

- Do not weaken or remove any existing call in `test/e2e/refusals.spec.ts`.
- Do not change `FORBIDDEN_BODY_KEYS` to add or drop a key.
- Do not modify any file under `test/integration/`, `test/contract/`, `test/unit/`,
  `test/migration/` or `test/performance/`.
- Do not modify any file under `src/`. This task is test-only.
- Do not change `jest.e2e.config.ts` or the `test/e2e/` entry in `jest.config.ts`'s
  `testPathIgnorePatterns`. Removing that entry would put the container-dependent suite into
  `npm test` and the 80% coverage gate.

#### Edge Cases

- **A response body is `undefined` or an empty object.** `collectLeakedKeys` already returns
  `[]` for a non-object, so the assertion passes. That is correct: no body cannot leak.
- **A body legitimately contains a `query` key.** None does today. If one appears, stop and
  report rather than adding an exclusion — a `query` key in a caller-facing body is the
  defect FR-006 exists to catch.
- **`typecheck` rejects `expect` in a non-spec file.** Import it explicitly from
  `@jest/globals` in `test/support/e2e-app.ts` and no further change.

#### Verification

This suite needs a running Docker daemon.

```bash
cd /Users/nd/Work/projects/invoice-reservation
npm run test:e2e
npm run typecheck
npm run lint
npm test
```

Expected:
- `test:e2e` passes all three spec files.
- `typecheck` and `lint` exit zero.
- `npm test` reports **70 passed suites and 516 tests**, unchanged from the baseline in
  `specs/004-e2e-api-tests/baseline.md` — Tasks 2, 5, 6 and 7 add unit specs, so the count
  will have grown by exactly those specs and their tests; it must not have grown by the
  `test/e2e/` files.

#### Completion Criteria

- [ ] `expectNoLeakedInternals` is exported from `test/support/e2e-app.ts` and defined nowhere else.
- [ ] All three `test/e2e/*.spec.ts` files import it.
- [ ] Every asserted response body in the boundary and contention specs is passed to it.
- [ ] The existing `40001` / `40P01` assertions in the contention spec are unchanged.
- [ ] `npm run test:e2e` passes.

---

### Task 9: Tick the completed convergence tasks

#### Objective

Mark each task this plan completed, and only those, as done in its feature's `tasks.md`.

#### Files

- `specs/001-program-capacity-reservation/tasks.md` — MODIFIED.
- `specs/002-openapi-docs-readme/tasks.md` — MODIFIED.
- `specs/004-e2e-api-tests/tasks.md` — MODIFIED.

#### Implementation

Change `- [ ]` to `- [x]` on exactly these lines, altering nothing else on any line:

- `specs/001-program-capacity-reservation/tasks.md`: **T104** (recorded as a trade-off by
  Task 1), **T105** (built by Task 2), **T106** (recorded as a deviation by Task 1).
- `specs/002-openapi-docs-readme/tasks.md`: **T009** and **T023** (Task 7), **T038** and
  **T044** (Task 5), **T039** and **T041** (Task 6), **T051** and **T071** (Task 4),
  **T067** (Task 5), **T068** (Task 6), **T069** (Task 3), **T070** and **T045**
  (recorded as a residual manual step by Task 1).
- `specs/004-e2e-api-tests/tasks.md`: **T030** (Task 8).

#### Constraints

- Change only the three characters inside a checkbox. Never reword, reorder, renumber or
  delete a task line.
- Do **not** tick 002's T061, T062, T065 or T066. They are measurement and walkthrough
  tasks with no artefact and are explicitly out of scope.
- Do **not** tick 003's T034. It stays open until a docs-only pull request proves the
  negative trigger.
- Do not touch `specs/003-mutation-testing/tasks.md` at all.
- Do not modify any `spec.md` or `plan.md`.

#### Edge Cases

- **A listed task is already ticked.** Leave it; do not double-edit.
- **A listed ID does not exist in its file.** Stop and report which one. Do not tick a
  neighbouring line.
- **T044 guards two specs.** Tick it only if both `test/unit/openapi-validity.spec.ts` and
  `test/unit/openapi-examples.spec.ts` exist and pass. If either is missing, leave T044
  open and report.

#### Verification

```bash
cd /Users/nd/Work/projects/invoice-reservation
git diff --numstat specs/
grep -n '^- \[ \]' specs/001-program-capacity-reservation/tasks.md specs/002-openapi-docs-readme/tasks.md specs/004-e2e-api-tests/tasks.md
```

Expected:
- `--numstat` shows **equal** insertions and deletions for each file, proving line-for-line
  edits with nothing added or removed.
- The `grep` lists only 002's T061, T062, T065 and T066 as still open across the three files.

#### Completion Criteria

- [ ] Insertions equal deletions for all three files.
- [ ] Only 002's T061, T062, T065, T066 remain unticked across the three files.
- [ ] `specs/003-mutation-testing/tasks.md` is unmodified.

---

---

### Task 3a: Narrow conformance test 12 to codes observable over HTTP

**Status: planning decision issued 2026-09-21, in response to an executor stop at Task 3.**
This task supersedes Task 3's "stop and report" edge case and Task 7's blanket prohibition
on modifying the conformance spec. Task 7's prohibition stands for every other part of that
file; it is lifted **only** for test 12's iteration set, as specified below.

#### Background — the contradiction

Task 3 correctly changed the three `@ApiResponse` `400` descriptions from
`'VALIDATION_FAILED or INVALID_AMOUNT'` to `'VALIDATION_FAILED'`. Those three descriptions
were the **only** place the string `INVALID_AMOUNT` appeared in the generated document.

`test/contract/openapi-conformance.contract.spec.ts` test 12,
`'12. every refusal code is documented and 503 never means anything else'`, does:

```ts
const serialised = JSON.stringify(document);
for (const code of REFUSAL_CODES) {
  expect(serialised).toContain(code);
}
```

`REFUSAL_CODES` in `src/capacity/domain/errors.ts` still contains `'INVALID_AMOUNT'`, so
test 12 now fails: `npm test` reports 1 failed / 528 passed.

The oracle, `specs/001-program-capacity-reservation/contracts/errors.md`, **never lists
`INVALID_AMOUNT` at all**. The document after Task 3 is therefore closer to the oracle than
before it. Test 12 is over-broad relative to the contract it exists to enforce: it demands
every domain refusal code appear in the HTTP document, but one of them is unreachable over
HTTP by construction.

#### Rejected alternatives

- **Revert Task 3.** Rejected: it would restore the documented defect this feature exists to
  remove, and move the document away from the oracle.
- **Remove `INVALID_AMOUNT` from `REFUSAL_CODES`.** Rejected: `releasePolicy` genuinely
  raises it, and it is reachable at the domain layer. Task 3 already forbids this.
- **Add `enum: REFUSAL_CODES` to `ErrorResponse.code` in
  `src/capacity/api/response/error.response.ts`.** Rejected, and this is the trap: it would
  make the document assert that a caller can receive `INVALID_AMOUNT` — the exact claim Task
  3 removed — and it would be wrong in the other direction too, because `VALIDATION_FAILED`
  is the code a caller actually receives on a `400` and is not a member of `REFUSAL_CODES`.

#### Objective

Make test 12 assert what the contract actually requires: every refusal code a caller can
observe over HTTP is documented, and every code that cannot be observed is provably absent.

#### Files

- `test/contract/openapi-conformance.contract.spec.ts` — MODIFIED. Test 12 only.
- `docs/ASSUMPTIONS.md` — MODIFIED. Extend the section Task 3 rewrote.

#### Implementation

1. In `test/contract/openapi-conformance.contract.spec.ts`, above the `it('12. ...')` block,
   add a module-scope constant with an explanatory comment:

   ```ts
   /**
    * Refusal codes that exist in the domain but cannot be observed over HTTP, so the
    * generated document must NOT document them. `INVALID_AMOUNT` is raised by
    * `releasePolicy` for a non-positive release amount, but `CreateReleaseDto.amount` is a
    * `PositiveMoneyDto` whose `amountMinor` carries `@Matches(/^[1-9][0-9]{0,18}$/)`, so the
    * global ValidationPipe returns `400 VALIDATION_FAILED` before the domain guard runs.
    * `specs/001-program-capacity-reservation/contracts/errors.md` — the oracle — does not
    * list it either.
    */
   const UNREACHABLE_OVER_HTTP: readonly string[] = ['INVALID_AMOUNT'];
   ```

2. Replace the first five lines of test 12's body:

   ```ts
   const serialised = JSON.stringify(document);
   for (const code of REFUSAL_CODES) {
     expect(serialised).toContain(code);
   }
   ```

   with:

   ```ts
   const serialised = JSON.stringify(document);
   for (const code of REFUSAL_CODES) {
     if (UNREACHABLE_OVER_HTTP.includes(code)) {
       // Documenting it would tell a caller about a code it can never receive.
       expect(serialised).not.toContain(code);
       continue;
     }
     expect(serialised).toContain(code);
   }
   ```

3. Change **nothing else** in test 12. The `expect(REFUSAL_STATUS.POSITION_UNVERIFIED).toBe(503)`
   assertion and the whole `503` loop below it stay exactly as they are.

4. Change nothing else in the file. Tests 1-11 and 13-16 are untouched.

5. In `docs/ASSUMPTIONS.md`, find the section headed
   ``## The `400` response names a refusal code a caller cannot observe`` — Task 3 rewrote
   its body to record that the descriptions were corrected. Append two sentences to that same
   body recording the consequence: conformance test 12 previously required every member of
   `REFUSAL_CODES` to appear in the generated document, and `INVALID_AMOUNT` satisfied it only
   through the inaccurate `400` descriptions; test 12 now excludes the codes listed in its
   `UNREACHABLE_OVER_HTTP` constant and asserts their **absence** instead, so the document
   cannot silently regain the claim. Do not add a new `##` section for this.

#### Constraints

- Do not modify `src/capacity/domain/errors.ts`, `src/capacity/api/error.filter.ts`, or
  `src/capacity/api/response/error.response.ts`.
- Do not modify `specs/001-program-capacity-reservation/contracts/errors.md` or
  `contracts/http-api.yaml`. They are the oracle.
- Do not re-add `INVALID_AMOUNT` to any `@ApiResponse` description.
- Do not delete, skip, or rename test 12, and do not touch any other test in the file.
- Do not add `VALIDATION_FAILED` to `REFUSAL_CODES`.
- `UNREACHABLE_OVER_HTTP` must contain exactly one entry, `'INVALID_AMOUNT'`. Do not add a
  second entry to make some other assertion pass — if a second code turns out to be
  undocumented, that is a real finding: stop and report it.

#### Edge Cases

- **`expect(serialised).not.toContain('INVALID_AMOUNT')` fails**, meaning the string is still
  somewhere in the document. Find it and report where. Do not weaken the assertion. The most
  likely cause is a fourth `@ApiResponse` description Task 3 missed, which Task 3's own edge
  case required searching for.
- **A different refusal code is missing from the document**, so the `toContain` branch fails
  for something other than `INVALID_AMOUNT`. That is a genuine documentation gap, not this
  task's business. Stop and report the code; do not add it to `UNREACHABLE_OVER_HTTP`.
- **This spec needs Docker.** It boots `AppModule` against real Postgres and Redis. If no
  daemon is reachable, stop and report rather than marking the task done on a skipped suite.

#### Verification

This spec needs a running Docker daemon.

```bash
cd /Users/nd/Work/projects/invoice-reservation
npx jest test/contract/openapi-conformance.contract.spec.ts
npm test
npm run typecheck
npm run lint
npm run docs:verify
```

Expected:
- The conformance spec passes in full, test 12 included.
- `npm test` reports **0 failed**. The previously failing test 12 now passes, giving 529
  passed and 0 failed against the 528-passed/1-failed state this task inherits.
- `typecheck`, `lint` and `docs:verify` all exit zero.

#### Completion Criteria

- [ ] `UNREACHABLE_OVER_HTTP` exists in the conformance spec with exactly one entry and the explanatory comment.
- [ ] Test 12 asserts presence for reachable codes and **absence** for unreachable ones.
- [ ] No other test in the conformance spec changed.
- [ ] No file under `src/` and no file under `specs/001-program-capacity-reservation/contracts/` changed.
- [ ] `npm test` reports 0 failed.
- [ ] The ASSUMPTIONS section records the test-12 narrowing in the existing section's body.


## Final Verification

1. Confirm no production behaviour regressed and no pre-existing gate changed its verdict.
2. Confirm the documentation gate now runs five documentation unit specs, not four.
3. Confirm the e2e suite still runs only from its own command.

Commands:

```bash
cd /Users/nd/Work/projects/invoice-reservation
npm run typecheck
npm run lint
npm run build
npm test
npm run test:cov
npm run docs:verify
npm run test:e2e
git diff --stat .github/workflows/ jest.config.ts jest.e2e.config.ts jest.recovery.config.ts jest.perf.config.ts jest.mutation.config.js stryker.config.mjs
```

Expected:
- `typecheck`, `lint` and `build` exit zero.
- `npm test` passes. Its suite and test counts are **higher** than the
  `specs/004-e2e-api-tests/baseline.md` figures of 70 suites / 516 tests by exactly the
  unit specs added in Tasks 2, 5, 6 and 7 — and by nothing else. No `test/e2e/` file may
  appear in its output.
- `npm run test:cov` passes its 80% global threshold. The threshold measures `src/` only;
  Task 2 is the only task adding `src/` lines, and it ships its own unit spec.
- `npm run docs:verify` prints `verify-docs: PASS` and its "documentation unit specs" line
  prints `ok`.
- `npm run test:e2e` passes all three spec files.
- The final `git diff --stat` prints **nothing**: no workflow and no Jest or Stryker
  configuration was touched by this plan.

Manual step that remains open by design, recorded in `docs/ASSUMPTIONS.md` by Task 1 and
not performed here: importing the exported document into two API clients (002 T045/T070).

## Executor Rules

1. Execute each task in a **separate sub-agent** with a fresh context; do not run multiple
   tasks inside one long-lived session.
2. Execute tasks strictly in numerical order.
3. Complete the current task and its verification before starting the next task.
4. Implement the solution described in the plan exactly.
5. Do not redesign architecture or substitute a different approach.
6. Do not add features, cleanup, abstractions, or refactors not explicitly required by the
   plan.
7. Do not omit planned behavior because another implementation appears simpler.
8. Do not reinterpret product requirements.
9. Do not make optional improvements.
10. Follow existing project conventions where the plan explicitly relies on them.
11. Run the verification specified for every task.
12. Mark a task complete only when its completion criteria are satisfied.
13. If implementation reveals information that does not affect the prescribed solution,
    continue execution.
14. Stop rather than improvise when the plan cannot be executed as written.

The executor may stop only for a concrete blocker such as:

- a referenced file, API, dependency, or subsystem does not exist;
- repository state materially contradicts facts the plan depends on;
- a required credential or external resource is unavailable;
- the prescribed implementation is technically impossible;
- executing the plan would require making an architectural or product decision not covered
  by the plan;
- two instructions in the plan directly contradict each other;
- verification proves that an assumption fundamental to the planned implementation is false.

When stopping, the executor must report: the task number; the exact blocker; the evidence
establishing the blocker; which plan assumption is invalid; and the minimum planning
decision required to continue.

The executor must **not** propose or implement an alternative unless explicitly asked to
re-plan.
