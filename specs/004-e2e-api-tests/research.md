# Phase 0 Research: End-to-End API Tests

**Feature**: 004-e2e-api-tests | **Date**: 2026-09-21

Every question the Technical Context raised, resolved against the repository as it stands
on `develop` plus the unmerged `003-mutation-testing` branch this worktree carries.

---

## R-001 — How is `PROGRAM_OVER_LIMIT` actually reached?

**Decision**: drive the program over its limit through the treasury harness
(`test/support/treasury.ts`), by applying a reconciliation snapshot that asserts a
treasury-reserved figure large enough that `local + treasury > creditLimit`. Then issue
the reservation over HTTP.

**Mechanism.** `decideReservation` in `src/capacity/domain/policies/reserve.policy.ts:33`
refuses with `PROGRAM_OVER_LIMIT` when `isOverLimit(program)` holds, and
`src/capacity/domain/program.ts:21` defines that as:

```ts
totalReserved(p) > p.creditLimitMinor       // local + treasury > limit
```

**This is the load-bearing finding of the whole feature.** The over-limit condition is
**unreachable through the API alone**. Constitution Principle III requires the database to
enforce `locally_reserved <= totalCreditLimit`, and that constraint binds exactly the
direction this service consumes capacity. So no sequence of reservations, however large or
however many, can push `local` past the limit — the database refuses first. Only
*externally asserted* state can raise the total above it: a treasury snapshot asserting a
larger treasury position, or a limit cut asserted from outside.

That is precisely why the refusal has no end-to-end coverage today. Reaching it needs a
write on the inbound treasury path, and every existing test that reaches it
(`test/integration/over-limit.spec.ts`, `test/integration/limit-reduction.spec.ts`) then
asserts the outcome at service level, never over HTTP.

**The harness needs no broker.** `buildTreasuryHarness(ds)` constructs
`ApplyTreasuryEventService`, `ApplySnapshotService` and their two handlers directly over a
`DataSource`. `over-limit.spec.ts` imports only `startPostgres` — no Redpanda. The inbound
path is exercised by handing a message to the handler, not by publishing to a topic. So
the e2e suite needs Postgres and Redis, not Redpanda.

**Alternatives rejected**:
- *Writing `over_limit_since` directly with SQL.* `isOverLimit` does not read that column —
  it recomputes from the position, so a direct write would not even trigger the refusal. It
  would also test a fixture rather than the production route, which the spec's Assumptions
  forbid.
- *Cutting the credit limit with SQL.* Same objection: it bypasses the snapshot path that
  sets the limit in production, and Principle II forbids setting a position behind the
  ledger's back. The snapshot path writes a compensating entry; raw SQL does not.
- *Publishing through a real Redpanda container.* Adds a third container and minutes of
  start-up to prove something the handler-level harness already proves, and every existing
  treasury test already made this call.

---

## R-002 — Where does the new suite live, and how does it stay out of `npm test`?

**Decision**: `test/e2e/*.spec.ts`, excluded from `jest.config.ts` via
`testPathIgnorePatterns`, run by its own `jest.e2e.config.ts` behind `npm run test:e2e`.

**Rationale.** `jest.config.ts` sets `roots: ['<rootDir>/src', '<rootDir>/test']` and
`testRegex: '.*\\.spec\\.ts$'`. A new file under `test/` is therefore picked up by
`npm test` **and** by `npm run test:cov` automatically. FR-011 requires every existing
command to behave exactly as before, so the exclusion is not optional — without it, adding
this feature silently lengthens the default test run and gives a new failure the power to
break the coverage gate.

The repository already solves this twice, and the new config copies the pattern verbatim:

| Suite | Excluded from `jest.config.ts` | Own config | Command |
|---|---|---|---|
| ledger recovery | `test/integration/ledger-recovery\.spec\.ts$` | `jest.recovery.config.ts` | `test:recovery` |
| performance | `test/performance/` | `jest.perf.config.ts` | `test:perf` |
| **e2e (new)** | `test/e2e/` | `jest.e2e.config.ts` | `test:e2e` |

`jest.e2e.config.ts` spreads `base` and overrides `testPathIgnorePatterns` and
`testRegex`, exactly as `jest.recovery.config.ts` does.

**Alternatives rejected**:
- *Let it join `npm test`.* Breaches FR-011 and puts container-dependent scenarios inside
  the coverage gate.
- *Name the files `*.e2e-spec.ts` and rely on the regex not matching.* Fragile — it depends
  on a regex written for another purpose, and the two existing excluded suites both use a
  plain `.spec.ts` name with a path-based exclusion. Consistency wins.

---

## R-003 — Does the new suite disturb the mutation gate (feature 003)?

**Decision**: no change required, and none permitted.

`jest.mutation.config.js` sets `roots: ['<rootDir>/test/unit']`, so files under `test/e2e/`
are invisible to it. `stryker.config.mjs` mutates only the six defended `src/` directories
and adds no test path. The mutation baseline is therefore unaffected by this feature, and
this feature must not touch either file.

One forward-looking note: a suite that kills more mutants would *raise* a future baseline,
but the mutation runner deliberately runs the unit set only, so it will not see these
tests. That is intended, not an oversight — container-backed suites cannot run per mutant.

---

## R-004 — How must the application be bootstrapped?

**Decision**: reuse the bootstrap `test/integration/reserve-endpoint.spec.ts` already
proves, extracted into a new shared helper `test/support/e2e-app.ts` used only by the new
suite.

The sequence that works, in order:

1. `startPostgres()` and `startRedis()`.
2. Set `MIGRATION_DATABASE_URL` and `DATABASE_URL` to the **owner** URL.
3. Set `REDIS_URL`, `KAFKA_BROKERS`, `KAFKA_LAG_PROBE_ENABLED=false`, the SASL pair,
   `JWT_SECRET`, and both rate-limit budgets.
4. Open an owner `DataSource`, `runMigrations()`, insert organisations, programs and FX
   rates.
5. **Switch `DATABASE_URL` to the app URL** before importing `AppModule`.
6. `Test.createTestingModule({ imports: [AppModule] }).compile()`, then
   `app.useGlobalPipes(createValidationPipe())`.
7. `await app.listen(0)`.

**Step 5 is a correctness requirement, not tidiness.** `DATABASE_URL` connects as
`capacity_app`, which is not the table owner, so the ledger's `REVOKE UPDATE, DELETE`
binds. Leaving the owner URL in place would let the application rewrite history and the
suite would pass while testing a permission model the production service does not have.

**Step 7 is load-bearing for User Story 3.** `reserve-endpoint.spec.ts:160` records the
reason in a comment: with `init()` alone, supertest starts and tears down the HTTP server
around individual requests, and under parallel load that race surfaces as a raw, body-less
`501`/`404` that never reached the Nest pipeline. A contention test built on `init()` would
produce exactly the symptom it claims to disprove. `listen(0)` gives every request one
stable listener.

Teardown reverses it: read `ThrottlerStorage`, `app.close()`, then
`storage.redis.disconnect()` — closing the app alone leaves the Redis client open and Jest
hangs.

**Alternatives rejected**:
- *Refactor the existing specs onto the new helper.* FR-009 forbids modifying any existing
  test. The helper is new code used by new files only; the duplication is deliberate.
- *A global setup file.* The suite needs per-file program state; a global fixture would
  couple scenarios and breach FR-007.

---

## R-005 — How is the capacity boundary computed, and what exactly is the off-by-one?

**Decision**: assert at `available`, at `available + 1`, and after a release returns
capacity.

`available(p) = creditLimitMinor - (localReservedMinor + treasuryReservedMinor)`
(`src/capacity/domain/program.ts:17`), and the refusal fires on
`reservedMinor > availableMinor` (`reserve.policy.ts:66`). The boundary is therefore
inclusive: a request for exactly `available` must be accepted.

`>` versus `>=` is the mutation that matters. It changes behaviour for exactly one input —
a request for precisely the remaining amount — and nothing else. The existing
thousand-request storm in `test/integration/concurrency.spec.ts` reserves 1,000 minor units
against a 100,000 limit, so no request in it ever lands on the boundary; the mutant
survives it untouched. A three-request deterministic test kills it in seconds.

The refusal carries `details.requestedMinor` and `details.availableMinor`, both decimal
strings. Asserting those, not merely the code, pins the arithmetic itself.

**Alternatives rejected**:
- *Extend the storm test.* It is already the slowest integration test in the repository,
  FR-009 forbids modifying it, and a boundary assertion inside a concurrency test confuses
  two failures that need separate diagnosis.

---

## R-006 — What can the API actually prove about deadlock?

**Decision**: assert the single-program contention guarantee. Record the multi-program
deadlock as unreachable.

`src/capacity/infrastructure/unit-of-work.ts:2` states the rule in a comment: a transaction
touching more than one program must take locks `ORDER BY id` ascending, because two
transactions taking the same pair in opposite orders deadlock. Both controllers are mounted
at `v1/programs/:programId` — one program per request — and the unit of work locks exactly
that one. **No supported request can express a two-program transaction**, so no sequence of
HTTP calls can provoke the ordering hazard the comment describes.

What the API *can* prove is the guarantee that matters to a caller: simultaneous writes to
one program serialize on the row lock, all complete, and none surfaces as a `500` or as a
serialization failure. `src/treasury/retry/failure-classifier.ts:43` treats `40001` and
`40P01` as transient, so a leak of either into a response is a defect the test must catch.

FR-013 forbids simulating the unreachable case below the API and presenting it as
end-to-end evidence. The spec's Assumptions record the debt: a multi-program endpoint makes
deadlock coverage owed the day it lands.

**Alternatives rejected**:
- *Open two raw transactions in the test and take programs in opposite orders.* That tests
  Postgres, not this service, and it is not end-to-end by any reading.
- *Call the unit of work directly with two program ids.* Below the API, so FR-001 and
  FR-013 both forbid it — and `concurrency-lock.spec.ts` already does it.

---

## R-007 — Where does the suite run in CI?

**Decision**: a new step in the existing `gate` job of `.github/workflows/ci.yml`, placed
after `Coverage gate` and before `Build`.

`gate` already runs on `ubuntu-latest` with a Docker daemon available — every existing
integration and contract test starts containers there — so no runner change is needed. Its
`timeout-minutes: 30` accommodates SC-004's 5-minute budget.

FR-014 requires the suite to run in the existing automated checks and forbids altering the
behaviour, triggers or reported results of any existing check. Adding a step satisfies
both: no existing step's command, order or outcome changes.

**On feature 003.** That feature required `ci.yml` to end with a zero diff *for its own
change*, and it carries its own workflow file, `mutation.yml`. It does not freeze `ci.yml`
against later features. 003 merged into `develop` as pull request #17 before this plan was
written, so there is no in-flight conflict: this feature edits `ci.yml` on top of a tree
that already carries the mutation workflow, and must leave `mutation.yml` untouched.

**Alternatives rejected**:
- *A separate workflow file.* 003 needed one because it wanted a path filter and a nightly
  schedule. This suite wants neither: it should run on every pull request, like the rest of
  the gate.

---

## R-008 — Which tooling, at which versions?

**Decision**: nothing new. `jest` 29.7.0, `ts-jest` 29.4.12, `supertest` 7.2.2,
`@types/supertest` 7.2.1, `@nestjs/testing` 11.2.5, `testcontainers` 12.1.0 and
`jsonwebtoken` are all already direct dev dependencies, all already used by the existing
HTTP-level specs.

The request named "jest, supertests" and that is exactly what is installed. No dependency
is added, so `package-lock.json` is untouched and `npm ci` is unaffected.

---

## R-009 — Measurements taken on 2026-09-21

Recorded so a later reader can tell drift from error. Taken in this worktree, on
`develop` plus the four unmerged 003 commits.

| Figure | Value |
|---|---|
| Existing spec files under `test/` | 74 |
| Existing HTTP-level specs booting the real `AppModule` | 20 |
| Refusal codes in `RefusalCode` | 14 |
| Refusal codes never asserted over HTTP | 5 |
| …of which reachable through an ordinary request | 4 |
| Controllers | 3 (`health`, `capacity`, `audit`) |
| Routes | 8, of which 2 are public probes |

**The uncovered set is the claim User Story 1 rests on**, so it was established code by
code rather than by impression. Each of the fourteen codes was grepped across
`test/contract` and `test/integration`, and every hit was read to see whether it asserts a
**response body** or merely a service return value.

| Refusal code | Observed over HTTP? | Where |
|---|---|---|
| `POSITION_UNVERIFIED` | yes | `recovery-detection.spec.ts:162`, both contract suites |
| `FX_RATE_UNAVAILABLE` | yes | `currency-mismatch.spec.ts:162` |
| `AMOUNT_ROUNDS_TO_ZERO` | yes | `currency-mismatch.spec.ts:210` |
| `INSUFFICIENT_CAPACITY` | yes | `concurrency.spec.ts:184` |
| `IDEMPOTENCY_CONFLICT` | yes | both contract suites |
| `CURRENCY_MISMATCH` | yes | `releases.contract.spec.ts:201` |
| `RESERVATION_TERMINAL` | yes | `releases.contract.spec.ts:257`, `cancellation.spec.ts` |
| `RELEASE_EXCEEDS_RESERVED` | yes | `releases.contract.spec.ts:218` |
| `NOT_FOUND` | yes | eight files |
| **`PROGRAM_OVER_LIMIT`** | **no** | `over-limit.spec.ts` only — service level |
| **`DUPLICATE_INVOICE`** | **no** | `reserve-service.spec.ts` only — service level |
| **`REQUEST_IN_FLIGHT`** | **no** | `idempotency.spec.ts` only — service level |
| **`IDEMPOTENCY_EXPIRED`** | **no** | `idempotency.spec.ts`, `idempotency-retention.spec.ts` — service level |
| **`INVALID_AMOUNT`** | **no** | asserted nowhere at all — see R-010 |

An earlier draft of this feature's specification claimed a single uncovered refusal. That
was wrong: it was reached by looking for the over-limit case specifically rather than by
walking the enumeration. Four reachable refusals are uncovered, not one, and User Story 1
was widened to match before planning continued.


---

## R-010 — `INVALID_AMOUNT` is unreachable through the API

**Decision**: record it as unreachable. Do not test it, and do not change production code
to make it reachable.

`releasePolicy` refuses `releaseMinor <= 0n` with `INVALID_AMOUNT`
(`src/capacity/domain/policies/release.policy.ts:55`). But `CreateReleaseDto.amount` is
typed `PositiveMoneyDto`, whose `amountMinor` carries
`@Matches(/^[1-9][0-9]{0,18}$/)`. Zero, a negative, and a leading-zero form are all
rejected by the global `ValidationPipe` before any controller code runs, so the request
returns `400 VALIDATION_FAILED` and the domain guard is never reached from HTTP.

The guard is not dead code — it defends the policy against a future caller that is not the
HTTP boundary, and the policy is also driven directly by the unit suite. It is simply
unobservable end to end.

**One inaccuracy noted, not fixed.** `capacity.controller.ts` documents the `400` response
of three operations as `'VALIDATION_FAILED or INVALID_AMOUNT'` (lines 109, 224 and 346).
A caller cannot observe the second. That is a documentation defect, it belongs to the
documentation gate rather than to this feature, and FR-010 forbids changing production
code here. Recorded so the next reader does not mistake it for something this feature
overlooked.

**Alternatives rejected**:
- *Loosen the DTO so the domain guard becomes reachable.* Changes production validation to
  suit a test. FR-010 forbids it, and it would weaken the boundary.
- *Bypass the pipe for one test.* Then the test no longer exercises the pipeline a real
  caller reaches, which is the whole point of FR-001.
