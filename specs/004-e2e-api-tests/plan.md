# Implementation Plan: End-to-End API Tests for Overbooking, Idempotency, Lock Contention and Access Control

**Branch**: `004-e2e-api-tests` | **Date**: 2026-09-21 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-e2e-api-tests/spec.md`

## Summary

Close the end-to-end gaps that survive an audit of the existing suite: four refusal codes a
caller can provoke but that no test has ever observed over HTTP, the capacity boundary at
its exact edge, and the single-program contention guarantee.

Technical approach: a new `test/e2e/` suite driving the assembled `AppModule` over HTTP
with supertest, behind a dedicated `jest.e2e.config.ts` and an `npm run test:e2e` script,
excluded from `jest.config.ts` so that `npm test` and `npm run test:cov` keep running
exactly the files they run today. The over-limit condition is reached through the treasury
handler harness, which is the only supported way to raise a program's total above its
limit. A new step in the existing `gate` job runs the suite on every pull request.

## Technical Context

**Language/Version**: TypeScript 5.6.3 on Node 22.x (`engines: >=22.0.0 <23`), `strict`
with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

**Primary Dependencies**: none added. Jest 29.7.0, ts-jest 29.4.12, supertest 7.2.2,
`@types/supertest` 7.2.1, `@nestjs/testing` 11.2.5, `testcontainers` 12.1.0 and
`jsonwebtoken` are already direct dev dependencies and already used by the twenty existing
HTTP-level specs. `package.json` gains one script; `package-lock.json` is untouched.

**Storage**: Postgres, via `@testcontainers/postgresql` through `test/support/postgres-container.ts`.
Redis, via `test/support/redis-container.ts`, because the throttler storage requires it.
**No Redpanda** — see R-001.

**Testing**: the feature *is* tests. The new suite is the deliverable; it asserts against
the real request pipeline and against the recorded ledger, never against a mock.

**Target Platform**: developer macOS/Linux workstations with a container runtime, and
`ubuntu-latest` GitHub-hosted runners.

**Project Type**: single NestJS service; this feature adds test code and its configuration
only.

**Performance Goals**: the whole new suite under **5 minutes** on the CI runner (SC-004).
Container start-up dominates; the scenarios themselves are a few dozen requests.

**Constraints**: no existing test may be modified (FR-009); no production behaviour may
change (FR-010); `npm test`, `npm run test:unit`, `npm run test:cov`, `npm run test:recovery`,
`npm run test:perf`, `npm run test:mutation`, `npm run typecheck`, `npm run lint`,
`npm run build` and `npm run docs:verify` must behave exactly as before (FR-011); the suite
imports only public entry points and `test/support/` (FR-015 — **not enforceable by lint**,
because `boundaries/include` is scoped to `src/**/*.ts`, so verification is by inspection);
no scenario may duplicate an existing end-to-end assertion (FR-012).

**Scale/Scope**: 3 new spec files, 1 new support helper, 1 new Jest config, 1 script entry,
1 CI step, 1 line added to `jest.config.ts`, and two documentation touches. Roughly 20
assertions across 3 user stories, delivered as 29 tasks.
Measured baseline on 2026-09-21: **74 spec files** under `test/`, of which **20** boot the
real `AppModule`; **14** refusal codes, of which **9** are observed over HTTP.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1.*

| Principle | Applies? | Verdict |
|---|---|---|
| I — Money is never floating point | **Yes** | **PASS.** Every amount the suite sends or asserts is a decimal string in minor units with an explicit currency, matching the wire contract. No assertion converts an amount to a JavaScript number, including the boundary arithmetic, which is done in `bigint`. |
| II — Capacity is a ledger | **Yes** | **PASS, and enforced.** FR-005 requires every writing scenario to assert the recorded position, not merely the response. No scenario sets a position directly; the over-limit condition is reached through the snapshot path, which writes a compensating entry, exactly as the principle requires. |
| III — Concurrency safety | **Yes** | **PASS.** User Story 3 asserts the guarantee the principle states. User Story 1 asserts the over-limit refusal the principle mandates — "all new reservations against it MUST be refused" — which until now had no end-to-end evidence at all. |
| IV — Idempotency and ordering | **Yes** | **PASS.** Two of the four uncovered refusals are idempotency refusals. The principle distinguishes a matching replay, a content conflict, an in-flight request and an expired record; the first two are covered today, and this feature covers the other two. |
| V — Secure and authenticated by default | **Yes** | **PASS.** Already covered end to end by `auth-enumeration.contract.spec.ts` and deliberately not re-asserted (FR-012). The suite connects as the non-owner role, so the ledger's `REVOKE` binds during the run — see R-004 step 5. |
| VI — Test-first with concurrency and failure coverage | **Yes** | **PASS.** See below. |
| VII — Runnable locally, observable in production | **Yes** | **PASS conditional on the ASSUMPTIONS.md task.** |

**Principle VI.** This feature adds only tests, so "failing test first" applies in an
unusual direction: there is no production code to drive out. The principle's intent is
honoured through SC-008, which requires the new boundary assertions to be *seen failing*
before they are trusted — a deliberately introduced off-by-one in the capacity comparison,
on a throwaway copy that is never committed, must turn the suite red. A test never observed
failing proves nothing, and the same discipline was applied to feature 003's own gate.

Coverage is unaffected: `collectCoverageFrom` is scoped to `src/**/*.ts`, the new suite is
excluded from `jest.config.ts`, and so `npm run test:cov` measures exactly what it measures
today. The 80% global threshold is neither helped nor harmed.

**Principle VII** requires every assumption and trade-off in `docs/ASSUMPTIONS.md`. Four
entries are owed and are a required deliverable, not polish:

1. The scope cut — two of the four requested concerns were already covered end to end, and
   re-asserting them was rejected. This is the feature's largest decision and the one most
   likely to be questioned later.
2. The two unreachable cases and why each is unreachable: the multi-program deadlock
   (R-006) and the non-positive release amount (R-010), together with the debt that falls
   due if a multi-program endpoint is ever added.
3. The suite's exclusion from `npm test`, and why a fourth Jest config is the right answer
   rather than letting the files join the default run.
4. The documentation inaccuracy found and deliberately not fixed: three operations document
   a `400 INVALID_AMOUNT` a caller cannot observe (R-010).

The merge gate requires that file to be current, so omitting these blocks merge.

**Constitution Check result: PASS.** No violation requires an entry in Complexity Tracking.

**Post-Phase-1 re-evaluation: PASS, unchanged.** The Phase 1 design adds one root
configuration file, one test-support helper, three spec files and one CI step. It adds no
module, no import into `src/`, and no production code path, so no principle's applicability
changes.

## Project Structure

### Documentation (this feature)

```text
specs/004-e2e-api-tests/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 output — R-001..R-010
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   ├── e2e-command.md         # CLI contract: invocation, isolation, exit status
│   └── fixture-contract.md    # What each scenario may assume and must establish
├── checklists/
│   └── requirements.md  # 16/16 passing
└── tasks.md             # Created by /speckit-tasks, NOT by this command
```

### Source Code (repository root)

This feature adds no `src/` file. It touches the repository at exactly these points:

```text
.
├── jest.e2e.config.ts               # NEW — spreads jest.config, targets test/e2e only
├── jest.config.ts                   # MODIFIED — one entry added to testPathIgnorePatterns
├── package.json                     # MODIFIED — one script: test:e2e
├── test/
│   ├── support/
│   │   └── e2e-app.ts               # NEW — the bootstrap of R-004, used only by test/e2e
│   └── e2e/                         # NEW directory
│       ├── refusals.spec.ts         # US1 — the four uncovered reachable refusals
│       ├── capacity-boundary.spec.ts# US2 — exact edge, one over, and after a release
│       └── contention.spec.ts       # US3 — simultaneous writes on one program
├── docs/ASSUMPTIONS.md              # MODIFIED — four required entries
├── README.md                        # MODIFIED — document `npm run test:e2e` (FR-008)
├── CLAUDE.md                        # MODIFIED — add the command to the Commands block
└── .github/workflows/
    ├── ci.yml                       # MODIFIED — one step in the existing gate job
    ├── release-gates.yml            # UNTOUCHED
    └── mutation.yml                 # UNTOUCHED
```

**The `jest.config.ts` edit is not optional.** `roots` includes `<rootDir>/test` and
`testRegex` is `.*\.spec\.ts$`, so without an ignore entry every new file joins `npm test`
and `npm run test:cov` automatically, breaching FR-011. The repository already handles this
twice — `test/integration/ledger-recovery.spec.ts` and `test/performance/` are both
excluded the same way. See R-002.

**`package-lock.json` is deliberately untouched.** No dependency is added, so `npm ci`
behaves identically and no lockfile churn reaches review.

**`test/support/e2e-app.ts` is new, not extracted.** The bootstrap it contains is proven by
`test/integration/reserve-endpoint.spec.ts`, but FR-009 forbids modifying that file to use
a shared helper. The duplication is deliberate and bounded to one new file.

**Two things in the bootstrap are correctness requirements, not style** (R-004):
`DATABASE_URL` must be switched to the **app** URL before `AppModule` is imported, so the
ledger's `REVOKE UPDATE, DELETE` binds during the run; and the application must be started
with `app.listen(0)` rather than `init()`, because under parallel load supertest otherwise
races the server lifecycle and produces body-less responses that never reached the Nest
pipeline — which is exactly the symptom User Story 3 exists to disprove.

**Structure Decision**: a sibling test directory with its own Jest config and npm script,
matching the pattern the repository already uses for the recovery and performance suites.
The alternative — letting the files join the default run — was rejected under FR-011,
because it lengthens every developer's test cycle and puts container-dependent scenarios
inside the coverage gate.

## Complexity Tracking

> No Constitution Check violations. This section is intentionally empty.
