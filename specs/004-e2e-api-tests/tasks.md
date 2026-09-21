---

description: "Task list for feature implementation"
---

# Tasks: End-to-End API Tests for Overbooking, Idempotency, Lock Contention and Access Control

**Input**: Design documents from `/specs/004-e2e-api-tests/`

**Prerequisites**: plan.md, spec.md, research.md (R-001..R-010), data-model.md,
contracts/e2e-command.md, contracts/fixture-contract.md, quickstart.md

**Tests**: This feature *is* tests. There is no production code to drive out, so the usual
"tests before implementation" split does not apply — each user-story task delivers spec
files that are themselves the deliverable. Constitution Principle VI is honoured instead
through T024, which requires the new assertions to be **seen failing** before they are
trusted.

**Organization**: grouped by user story. Each story is one spec file and can be written,
run and reviewed on its own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1, US2, US3 — maps to the user stories in spec.md

## Path Conventions

Single NestJS service, repository root. Tests under `test/{unit,integration,migration,contract,performance}/`;
this feature adds `test/e2e/`. Root-level Jest configuration, matching the existing
`jest.config.ts`, `jest.recovery.config.ts` and `jest.perf.config.ts`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: create the isolated runner **before** any spec file exists.

> **⚠️ Order matters.** `jest.config.ts` has `roots: ['<rootDir>/src', '<rootDir>/test']`
> and `testRegex: '.*\.spec\.ts$'`. Until T002 lands, any file created under `test/e2e/`
> is picked up by `npm test` **and** `npm run test:cov` automatically, breaching FR-011.
> Do not create `test/e2e/` before T002 is complete.

- [ ] T001 Create `jest.e2e.config.ts` at the repository root: import `Config` from `jest`
      and `base` from `./jest.config`, spread `base`, and override
      `testPathIgnorePatterns: ['/node_modules/']` and `testRegex: 'test/e2e/.*\.spec\.ts$'`.
      Mirror `jest.recovery.config.ts` exactly in shape, including its explanatory header
      comment stating why the suite is excluded from the default run.

- [ ] T002 Add `'test/e2e/'` to the `testPathIgnorePatterns` array in `jest.config.ts`,
      after the existing `'test/performance/'` entry. This is the **only** permitted change
      to that file (contract C-4.2) — no other line may move.

- [ ] T003 Add `"test:e2e": "jest --config jest.e2e.config.ts"` to the `scripts` block of
      `package.json`, placed immediately after `"test:perf"`. Add no dependency; per R-008
      every package the suite needs is already a direct devDependency, so
      `package-lock.json` must end with an empty diff.

- [ ] T004 Verify the isolation before writing any test. Run `npm test` and
      `npm run test:cov` and record the suite count, test count and coverage percentages.
      Run `npm run test:e2e` and confirm it exits non-zero with "no tests found" (there are
      none yet) rather than running the existing suites. Confirm
      `git diff --stat jest.mutation.config.js stryker.config.mjs jest.recovery.config.ts jest.perf.config.ts package-lock.json`
      prints nothing.

**Checkpoint**: the runner exists and is provably isolated. Numbers from T004 are the
baseline T025 compares against.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the bootstrap every story depends on.

**⚠️ CRITICAL**: no user story can begin until T005 is complete.

- [ ] T005 Create `test/support/e2e-app.ts` exporting a fixture that starts the
      application and a matching teardown, following R-004 step by step:
      (1) `startPostgres()` and `startRedis()` from the existing
      `test/support/postgres-container.ts` and `test/support/redis-container.ts`;
      (2) set `MIGRATION_DATABASE_URL` and `DATABASE_URL` to the **owner** URL;
      (3) set `REDIS_URL`, `KAFKA_BROKERS`, `KAFKA_LAG_PROBE_ENABLED='false'`,
      `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD`, `JWT_SECRET`,
      `RATE_LIMIT_READ_PER_MINUTE` and `RATE_LIMIT_WRITE_PER_MINUTE`;
      (4) open an owner `DataSource`, `runMigrations()`, seed the FX rate pairs the
      existing HTTP specs seed;
      (5) **switch `DATABASE_URL` to the app URL before importing `AppModule`**;
      (6) `Test.createTestingModule({ imports: [AppModule] }).compile()`, then
      `app.useGlobalPipes(createValidationPipe())`;
      (7) `await app.listen(0)`.
      Also export a token-minting helper taking an organisation id and a scope, signing
      with the same `JWT_SECRET` and `algorithm: 'HS256'`.

      **Two steps are correctness requirements, not style.** Step 5: `DATABASE_URL`
      connects as `capacity_app`, which is not the table owner, so the ledger's
      `REVOKE UPDATE, DELETE` binds. Leaving the owner URL in place lets the application
      rewrite history and the suite passes while testing a permission model production does
      not have. Step 7: with `init()` alone supertest races the server lifecycle under
      parallel load and returns body-less `501`/`404` responses that never reached the Nest
      pipeline — exactly the symptom US3 exists to disprove.

- [ ] T006 Add the teardown to `test/support/e2e-app.ts` per contract F-6, in order:
      read `ThrottlerStorage` from the app, `await app.close()`, then
      `storage.redis.disconnect()` (closing the app alone leaves the Redis client open and
      Jest hangs); destroy the owner `DataSource`; restore every environment variable the
      fixture set; stop Redis; stop Postgres. Guard every step so a failure in setup cannot
      cascade into a teardown crash that hides the original error.

**Checkpoint**: a spec file can boot the real application over HTTP. Stories may now
proceed, and T007, T012 and T017 touch different files so the three may run in parallel.

---

## Phase 3: User Story 1 — Every reachable capacity refusal is observed through the API (Priority: P1) 🎯 MVP

**Goal**: the four refusal codes a caller can provoke but that no test has ever observed
over HTTP — `PROGRAM_OVER_LIMIT`, `DUPLICATE_INVOICE`, `REQUEST_IN_FLIGHT`,
`IDEMPOTENCY_EXPIRED` — each asserted end to end.

**Independent Test**: `npm run test:e2e -- -t 'refus'` passes, and grepping `test/e2e/` for
each of the four codes finds an assertion on a **response body**, not on a service return
value.

- [ ] T007 [US1] Create `test/e2e/refusals.spec.ts` with the shared bootstrap from
      `test/support/e2e-app.ts` in `beforeAll` and the teardown in `afterAll`. Add no
      scenario yet; confirm `npm run test:e2e` starts the containers, boots the app and
      reports zero tests. This isolates bootstrap failures from assertion failures.

- [ ] T008 [US1] Add the over-limit scenario to `test/e2e/refusals.spec.ts`, following
      contract F-4 exactly:
      (1) insert an organisation and a program with a known `credit_limit_minor` and a
      known `local_reserved_minor`, `position_verified` **true**;
      (2) build the treasury harness with `buildTreasuryHarness(ownerDataSource)` from
      `test/support/treasury.ts`;
      (3) apply a `snapshotMessage` asserting a `treasury_reserved_minor` such that
      `local + treasury > credit_limit_minor`;
      (4) **assert the precondition** — read the program row back and confirm
      `totalReserved > creditLimitMinor`;
      (5) `POST /v1/programs/:programId/reservations` with a write-scoped token and an
      `Idempotency-Key`; assert status `409`, `body.code === 'PROGRAM_OVER_LIMIT'`, and
      that `local_reserved_minor` is unchanged.

      Step 4 is not decoration. If the snapshot is rejected — by the delta guard, by a
      stale version, or by a quarantine rule — the program is still within its limit, the
      reservation returns `201`, and a reader blames the refusal logic rather than the
      fixture.

      **Do not** write `over_limit_since` directly (F-3.4): `isOverLimit` recomputes from
      the position and never reads that column, so such a fixture proves nothing. **Do not**
      set the position with `UPDATE` (F-3.3): Principle II forbids setting a position behind
      the ledger's back.

- [ ] T009 [US1] Add the over-limit **clearance** scenario to `test/e2e/refusals.spec.ts`:
      from the over-limit state, apply a snapshot returning the treasury figure to within
      the limit, then retry the same reservation and assert `201`, **and read
      `local_reserved_minor` back to confirm the reservation was recorded** (FR-005 applies
      to every scenario that writes, not only to the refusals). Proves the refusal is a
      function of position, not a sticky flag. Use its own program row — T008's program
      must not be reused (F-2.1).

- [ ] T010 [US1] Add the `DUPLICATE_INVOICE` scenario to `test/e2e/refusals.spec.ts`:
      reserve an invoice successfully, then reserve **the same `invoiceId`** against the
      same program under a **different** `Idempotency-Key`. Assert status `409`,
      `body.code === 'DUPLICATE_INVOICE'`, and that `local_reserved_minor` reflects exactly
      one reservation. The differing key is what makes this a duplicate-invoice refusal
      rather than an idempotency replay — with the same key it would return `200` and this
      scenario would prove nothing.

- [ ] T011 [US1] Add the `REQUEST_IN_FLIGHT` and `IDEMPOTENCY_EXPIRED` scenarios to
      `test/e2e/refusals.spec.ts`. Per data-model.md, `request_record` is keyed on
      organisation plus request identifier and carries a state and a content fingerprint;
      a `PENDING` record yields `REQUEST_IN_FLIGHT` and a record aged past retention yields
      `IDEMPOTENCY_EXPIRED`. Establish each state, then present the key over HTTP and assert
      status `409` and the **specific** code. Asserting merely "refused" is insufficient:
      Principle IV distinguishes four outcomes — matching replay, content conflict,
      in-flight, expired — and conflating them is the defect this scenario exists to catch.

      Every scenario in this file must also assert, per F-5.5, that the response body
      carries no `stack`, `sql` or `query` key at any depth.

      Add a comment at the head of this file recording the **fourteenth** refusal code and
      why it is absent: `INVALID_AMOUNT` is raised by `releasePolicy` for a non-positive
      release amount, but `CreateReleaseDto.amount` is a `PositiveMoneyDto` whose
      `amountMinor` carries `@Matches(/^[1-9][0-9]{0,18}$/)`, so the global `ValidationPipe`
      returns `400 VALIDATION_FAILED` before the domain guard runs (R-010). SC-006 requires
      a reviewer to name **both** unreachable cases from the suite alone; T021 records the
      other one in `test/e2e/contention.spec.ts`.

**Checkpoint**: 13 of 14 refusal codes are now observed over HTTP, up from 9. US1 is
complete and independently reviewable.

---

## Phase 4: User Story 2 — The overbooking boundary is proven deterministically (Priority: P1)

**Goal**: the capacity boundary asserted at its exact edge, without relying on the existing
thousand-request storm.

**Independent Test**: `npm run test:e2e -- -t 'boundary'` passes in under 30 seconds
excluding container start-up.

- [ ] T012 [P] [US2] Create `test/e2e/capacity-boundary.spec.ts` with the shared bootstrap
      and teardown from `test/support/e2e-app.ts`.

- [ ] T013 [US2] Add the **exactly available** scenario: insert a program whose
      `position_verified` is true, whose total is within the limit, and whose currency
      matches the request — per data-model.md the refusal checks run in the order
      `POSITION_UNVERIFIED` → `PROGRAM_OVER_LIMIT` → `FX_RATE_UNAVAILABLE` →
      `AMOUNT_ROUNDS_TO_ZERO` → `INSUFFICIENT_CAPACITY`, so any of the first four left
      unsatisfied means the boundary comparison is never reached and the test passes for the
      wrong reason. Reserve exactly `available = credit_limit_minor - (local + treasury)`,
      computed in `bigint`. Assert `201` and that the reflected availability reports nothing
      remaining.

- [ ] T014 [US2] Add the **one over** scenario, against its own fresh program: reserve
      `available + 1n`. Assert status `409`, `body.code === 'INSUFFICIENT_CAPACITY'`, and
      assert `body.details.requestedMinor` and `body.details.availableMinor` as decimal
      strings — the policy sets both, and asserting them pins the arithmetic rather than
      just the outcome. Assert the recorded position is unchanged.

      This pair is what kills a `>` to `>=` mutation in
      `src/capacity/domain/policies/reserve.policy.ts`. That mutation changes behaviour for
      exactly one input — a request for precisely the remaining amount — and the existing
      thousand-request storm reserves 1,000 against a 100,000 limit, so no request in it
      ever lands on the edge.

- [ ] T015 [US2] Add the **capacity returns** scenario: on a program with nothing
      remaining, release part of a prior reservation, then reserve the released amount and
      assert `201`. Proves released capacity re-enters the boundary calculation rather than
      leaking.

- [ ] T016 [US2] Assert the recorded position after each of T013, T014 and T015 by reading
      `local_reserved_minor` back from the program row (FR-005). Every amount sent and
      asserted must be a decimal string in minor units with an explicit currency, and every
      computation must be `bigint` — Principle I forbids a floating-point step anywhere,
      including in the test's own arithmetic.

**Checkpoint**: the boundary is pinned at the edge and either side of it.

---

## Phase 5: User Story 3 — Contention on one program never surfaces as a failure (Priority: P2)

**Goal**: simultaneous writes to a single program all complete, none surfaces as a server
error or a serialization failure, and the resulting position is exact.

**Independent Test**: `npm run test:e2e -- -t 'contention'` passes.

- [ ] T017 [P] [US3] Create `test/e2e/contention.spec.ts` with the shared bootstrap and
      teardown from `test/support/e2e-app.ts`.

- [ ] T018 [US3] Add the simultaneous-reservations scenario: against one program with
      capacity for all of them, issue **exactly five** reservations at once from the same
      organisation, each with its own `invoiceId` and its own `Idempotency-Key`. Five is
      enough to serialize on the row lock without approaching the thousand-request storm in
      `test/integration/concurrency.spec.ts`, which FR-012 forbids duplicating. Assert
      every response is `201`, no response is `5xx`, and no response body mentions a
      serialization or deadlock failure — `src/treasury/retry/failure-classifier.ts` treats
      Postgres `40001` and `40P01` as transient, so either code reaching a caller is the
      defect this scenario catches.

- [ ] T019 [US3] Assert the resulting position equals the sum of the accepted reservations
      exactly, read back from `local_reserved_minor`. No write lost, none double-counted.

- [ ] T020 [US3] Add the mixed-operation scenario: issue a reservation, a release of an
      earlier reservation and a cancellation of another, simultaneously against the same
      program. Assert each is accepted or refused on its own merits and that none fails for
      contention.

- [ ] T021 [US3] Add a comment at the head of `test/e2e/contention.spec.ts` recording what
      this file deliberately does **not** test and why: a genuine multi-program deadlock
      needs two transactions taking two programs in opposite orders;
      `src/capacity/infrastructure/unit-of-work.ts` locks exactly one program per
      transaction and both controllers are mounted at `v1/programs/:programId`, so no
      supported request can express it (R-006). FR-013 forbids simulating it below the API
      and presenting the result as end-to-end evidence. Note the debt: a multi-program
      endpoint makes deadlock coverage owed the day it lands.

**Checkpoint**: all three stories independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T022 Add a `Run end-to-end API tests` step to the existing `gate` job in
      `.github/workflows/ci.yml`, running `npm run test:e2e`, placed after `Coverage gate`
      and before `Build`. Change no existing step's command, order or name. `gate` already
      has a Docker daemon and `timeout-minutes: 30`, which accommodates the 5-minute budget.
      Leave `.github/workflows/release-gates.yml` and `.github/workflows/mutation.yml`
      untouched — `mutation.yml` arrived with feature 003, merged as pull request #17.

- [ ] T023 Add **four** entries to `docs/ASSUMPTIONS.md`, each with its rationale:
      (1) the scope cut — idempotency and access control were found already covered end to
      end and re-asserting them was rejected under FR-012; this is the feature's largest
      decision and the one most likely to be questioned later;
      (2) the two unreachable cases — the multi-program deadlock (R-006) and the
      non-positive release amount (R-010) — and the debt that falls due if a multi-program
      endpoint is added;
      (3) the suite's exclusion from `npm test`, and why a fourth Jest config beats letting
      the files join the default run;
      (4) the documentation inaccuracy found and deliberately not fixed —
      `src/capacity/api/capacity.controller.ts` lines 109, 224 and 346 document the `400`
      response as `'VALIDATION_FAILED or INVALID_AMOUNT'`, but a caller cannot observe the
      second, because `CreateReleaseDto.amount` is a `PositiveMoneyDto` whose `amountMinor`
      carries `@Matches(/^[1-9][0-9]{0,18}$/)` and validation refuses before the domain
      guard runs.

      The merge gate requires this file to be current, so omitting these blocks merge.

- [ ] T024 Prove the new assertions can fail (SC-008, Constitution Principle VI). On a
      **scratch copy only, never the working branch**, change `reservedMinor > availableMinor`
      to `reservedMinor >= availableMinor` in
      `src/capacity/domain/policies/reserve.policy.ts`, run `npm run test:e2e`, and confirm
      it exits non-zero naming the boundary scenario. Discard the scratch copy entirely and
      confirm `git status --porcelain` is clean. The mutated source is never committed —
      FR-010 forbids changing production behaviour, and this is a throwaway probe.

- [ ] T025 Run the full isolation check of contract C-4 and compare against the T004
      baseline: `npm test`, `npm run test:unit`, `npm run test:cov`, `npm run test:recovery`
      is unchanged, `npm run test:mutation`, `npm run typecheck`, `npm run lint`,
      `npm run build`, `npm run docs:verify`. `npm test` must report the **same** suite and
      test counts as at T004 — if they grew, the T002 ignore entry is missing and
      `test/e2e/` has joined the default run. `npm run test:cov` must report the **same**
      percentages. Confirm `git diff --stat` on `jest.mutation.config.js`,
      `stryker.config.mjs`, `jest.recovery.config.ts`, `jest.perf.config.ts` and
      `package-lock.json` prints nothing.

- [ ] T026 Verify FR-012 by hand: for every scenario added in T008–T020, confirm no
      existing end-to-end test already makes the same assertion. Check especially
      `test/integration/reserve-endpoint.spec.ts`, `test/integration/concurrency.spec.ts`,
      `test/contract/reservations.contract.spec.ts`,
      `test/contract/releases.contract.spec.ts` and
      `test/contract/auth-enumeration.contract.spec.ts`. Confirm no file under `test/`
      other than the new ones has been modified (FR-009):
      `git diff --stat test/` must show only `test/e2e/` and `test/support/e2e-app.ts`.

      Also verify FR-015 **by inspection, not by lint**. `eslint.config.mjs` sets
      `'boundaries/include': ['src/**/*.ts']`, so eslint-plugin-boundaries never evaluates a
      file under `test/` and `npm run lint` passes whatever the suite imports. Read the
      import list of each new file and confirm every `src/` import is a module's public
      entry point and that nothing reaches into a layer's internals to shortcut a scenario.
      The permitted `src/` imports are the ones the existing HTTP-level specs already use:
      `src/app.module`, `src/shared/validation/create-validation-pipe`, plus the seeded
      constants from `scripts/seed`.

- [ ] T027 Run every scenario in `specs/004-e2e-api-tests/quickstart.md` in order, 1
      through 7, plus the repository hygiene check. Record the wall time of
      `npm run test:e2e` and confirm it is under 5 minutes (SC-004). Separately record the
      wall time of `npm run test:e2e -- -t 'boundary'` **excluding container start-up** and
      confirm it is under 30 seconds (SC-002); Jest's per-suite time is the figure to use.

- [ ] T028 Document the command (FR-008). Add `npm run test:e2e` wherever the project
      already documents how to run its tests, alongside `test:recovery` and `test:perf`:
      the Commands block of `CLAUDE.md` and the testing section of `README.md`. State in one
      line what the suite covers, that it needs a container runtime, and that it is
      deliberately excluded from `npm test`. A script entry in `package.json` alone does not
      satisfy "documented" — feature 003 shipped `docs/testing-mutation.md` plus README
      links for the same reason.

- [ ] T029 Verify the failure output (FR-016). On a scratch copy only, break one assertion
      in `test/e2e/capacity-boundary.spec.ts` — change the expected status of the
      `available + 1` scenario from `409` to `200` — run `npm run test:e2e`, and capture the
      output. Confirm it names the failing scenario, both the expected and the actual
      status, and the response `code`. If `body.code` is absent from the output, the
      scenario asserts the status without asserting the code and T014 is incomplete. Discard
      the scratch copy and confirm `git status --porcelain` is clean.

      This is not ceremony. A bare `expect(response.status).toBe(409)` satisfies the letter
      of FR-016 while printing no `code`, and the first person to hit a real failure is the
      one who discovers it.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies. **Must complete before any file is created under
  `test/e2e/`** — see the warning at the head of Phase 1.
- **Foundational (Phase 2)**: depends on Phase 1. Blocks all three stories.
- **User Stories (Phases 3–5)**: all depend on T005 and T006. Each story owns one spec
  file, so the three are mutually independent and may proceed in parallel.
- **Polish (Phase 6)**: T022, T023 and T028 depend only on the stories being complete.
  T024 and T029 depend on US2. T025, T026 and T027 depend on everything.

### User Story Dependencies

- **US1 (P1)**: after Phase 2. Independent.
- **US2 (P1)**: after Phase 2. Independent of US1.
- **US3 (P2)**: after Phase 2. Independent of US1 and US2.

### Within Each User Story

- The bootstrap task (T007, T012, T017) comes first and is verified on its own, so that a
  container or wiring failure is diagnosed before any assertion is written.
- Scenarios within a file are added in the listed order but do not depend on one another at
  runtime — F-2.1 requires each to establish its own program row.

### Parallel Opportunities

- T007, T012 and T017 create three different files and may run in parallel once T006 lands.
- T008 through T011 all edit `test/e2e/refusals.spec.ts` and are therefore **not** marked
  `[P]`, even though the scenarios are logically independent. `[P]` means different files.
  The same holds within US2 and US3.
- T022, T023 and T028 touch different files and may run in parallel.
- Nothing in Phase 1 is parallel: T002 must precede any `test/e2e/` file, and T004 verifies
  T001–T003 together.

---

## Parallel Example: after Phase 2

```text
Writer A: T007 → T008 → T009 → T010 → T011      (test/e2e/refusals.spec.ts)
Writer B: T012 → T013 → T014 → T015 → T016      (test/e2e/capacity-boundary.spec.ts)
Writer C: T017 → T018 → T019 → T020 → T021      (test/e2e/contention.spec.ts)
```

Three files, no shared state, no shared fixture instance — each spec file starts its own
containers.

---

## Implementation Strategy

### MVP

**Phase 1 + Phase 2 + Phase 3 (US1)** — T001 through T011. Delivers the four uncovered
refusals observed end to end, which is the largest single gap and the one with a direct
constitutional hook: Principle III requires that every new reservation against an
over-limit program be refused, and until this lands that requirement has no end-to-end
evidence at all.

### Incremental delivery

1. T001–T004 — the isolated runner, proven not to disturb anything.
2. T005–T006 — the bootstrap.
3. T007–T011 — US1. **Shippable here.**
4. T012–T016 — US2. Adds the boundary proof.
5. T017–T021 — US3. Adds the contention proof.
6. T022–T029 — automation, documentation, recorded assumptions, the two deliberate red
   steps, and verification.

### What must not happen

- No existing test modified (FR-009). The bootstrap in `test/support/e2e-app.ts` duplicates
  what `test/integration/reserve-endpoint.spec.ts` already proves; that duplication is
  deliberate and bounded to one new file.
- No production file changed (FR-010). T024's mutation is a throwaway probe on a scratch
  copy, never committed.
- No new dependency (R-008). `package-lock.json` ends with an empty diff.
- No scenario that duplicates an existing end-to-end assertion (FR-012), verified by T026.
