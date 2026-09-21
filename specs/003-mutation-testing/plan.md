# Implementation Plan: Mutation Testing for Business-Logic Test Effectiveness

**Branch**: `003-mutation-testing` | **Date**: 2026-09-21 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-mutation-testing/spec.md`

## Summary

Measure whether the existing unit suite actually detects changes to the money, ledger,
reservation and treasury-handling logic; turn the measured number into an enforced floor;
run the check automatically without disturbing any existing gate; and document how to act
on the result.

Technical approach: StrykerJS drives Jest over a **dedicated container-free Jest config**
restricted to `test/unit`, mutating only the six defended directories. `coverageAnalysis:
'perTest'` plus the TypeScript checker keep a full run inside the 10-minute budget. The
enforcement floor is written only **after** a baseline run reports a real score. A new,
separate GitHub Actions workflow carries the path filter and the nightly schedule, leaving
`.github/workflows/ci.yml` byte-identical.

## Technical Context

**Language/Version**: TypeScript 5.6.3 on Node 22.x (`engines: >=22.0.0 <23`), `strict`
with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; CommonJS modules
(`package.json` has no `"type"`).

**Primary Dependencies**: `@stryker-mutator/core`, `@stryker-mutator/jest-runner`,
`@stryker-mutator/typescript-checker` — new dev dependencies, version-matched and pinned.
Existing: Jest 29.7.0, ts-jest 29.4.12.

**Storage**: N/A. This feature reads source and writes reports; it touches no database.

**Testing**: the container-free unit set only — `test/unit`, **29 suites / 287 tests /
5.99 s** as measured on 2026-09-21. The container-dependent `test/integration`,
`test/migration`, `test/contract` and `test/performance` sets are structurally excluded.

**Target Platform**: developer macOS/Linux workstations and `ubuntu-latest` GitHub-hosted
runners.

**Project Type**: single NestJS service; this feature adds build/CI tooling only.

**Performance Goals**: a full mutation run completes in **under 10 minutes** on the CI
runner (FR-012).

**Constraints**: no Docker daemon may be required (FR-003); no existing test may be
modified (FR-023); no production behaviour may change (FR-024); `npm test`,
`npm run test:unit`, `npm run test:cov`, `npm run typecheck`, `npm run lint`,
`npm run build` and `npm run docs:verify` must behave exactly as before (FR-025); no new
cross-layer import (FR-026). `docs:verify` is the documentation drift gate added by feature
002 in PR #12; it postdates FR-025's wording but falls squarely inside its intent.
Both existing workflows — `ci.yml` and `release-gates.yml` — must end with a zero diff.

**Scale/Scope**: **32 source files, 3383 lines** across the six defended directories, of
which **zero** are removed by the FR-002 exclusion patterns today. Estimated 900–1600
mutants; the real figure comes from the baseline run.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1.*

| Principle | Applies? | Verdict |
|---|---|---|
| I — Money is never floating point | No | No monetary value is introduced, read or written. |
| II — Capacity is a ledger | No | No ledger interaction. |
| III — Concurrency safety | No | No transactional path is touched. |
| IV — Idempotency and ordering | No | No inbound event path is touched. |
| V — Secure and authenticated by default | No | No endpoint, credential or stream added. The CI job reads the repository and uploads a report; it needs no secret. |
| VI — Test-first with concurrency and failure coverage | **Yes** | **PASS with recorded justification** — see below. |
| VII — Runnable locally, observable in production | **Yes** | **PASS conditional on the ASSUMPTIONS.md task.** |

**Principle VI.** The principle mandates failing-test-first and ≥80% coverage. This feature
adds no production source code, so there is nothing for a unit test to assert about, and
`collectCoverageFrom` in `jest.config.ts` is scoped to `src/**/*.ts` — configuration files
and workflows are not measured by it, so the 80% global gate is neither helped nor harmed.

The principle's intent is nonetheless honoured, and the plan enforces it: the gate this
feature installs is itself verified by a **deliberate red step**. Before the floor is
trusted, a scratch copy has an assertion removed from one unit test in the defended scope,
and the mutation command must exit **non-zero**; the copy is then discarded. A gate that
has never been seen to fail is not a gate. This is recorded in `docs/ASSUMPTIONS.md`.

**Principle VII** requires every assumption and trade-off in `docs/ASSUMPTIONS.md`. Four
entries are owed and are a required deliverable, not polish: the measured baseline and the
derivation of the floor; the `perTest` + type-checker budget trade-off; the separate-workflow
decision; and the relocation of the retained prior-run state, described below. A fifth entry
recording the deferred README link is **no longer owed** — R-007 resolved when `README.md`
came into existence, and recording a deferral that no longer applies would mislead. The merge gate (Workflow item 5) requires that file to be current,
so omitting them blocks merge.

**The fifth entry records a deliberate deviation from the feature request.** The request
named `.stryker-tmp/incremental.json` as the committed prior-run state. This plan writes
it to `.stryker-incremental.json` at the repository root instead, because `.stryker-tmp/`
is Stryker's own sandbox directory — it is scratch space the tool creates and removes
around a run, so a file committed inside it is not durable. The root placement also keeps
the git-ignore rules disjoint and avoids a negation rule (R-004). The behaviour the
request asked for is unchanged; only the path differs. Recording it is what Principle VII
requires, and a gate installed to enforce test discipline should not itself carry an
unrecorded deviation.

**Constitution Check result: PASS.** No violation requires an entry in Complexity Tracking.

**Post-Phase-1 re-evaluation: PASS, unchanged.** The Phase 1 design introduces two root
configuration files, one workflow file, one documentation file and one npm script. It adds
no module, no import, and no production code path, so no principle's applicability changes.

## Project Structure

### Documentation (this feature)

```text
specs/003-mutation-testing/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 output — R-001..R-009
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   ├── mutation-command.md    # CLI contract: invocation, exit status, output
│   └── ci-job.md              # Automation contract: triggers, artefacts, isolation
├── checklists/
│   └── requirements.md  # 16/16 passing
└── tasks.md             # Created by /speckit-tasks, NOT by this command
```

### Source Code (repository root)

This feature adds no `src/` file. It touches the repository at exactly these points:

```text
.
├── stryker.config.mjs               # NEW — scope, runner, checker, thresholds, reporters
├── jest.mutation.config.js          # NEW — container-free Jest config, roots = test/unit
├── .stryker-incremental.json        # NEW, COMMITTED — retained prior-run state
├── .gitignore                       # MODIFIED — ignore reports/ and .stryker-tmp/
├── eslint.config.mjs                # MODIFIED — defensive only; see note below
├── package.json                     # MODIFIED — devDeps + `test:mutation` script
├── package-lock.json                # MODIFIED — three new devDeps resolved
├── docs/
│   ├── testing-mutation.md          # NEW — how to run, read, and act on results
│   └── ASSUMPTIONS.md               # MODIFIED — four required entries
├── README.md                        # MODIFIED — two links into testing-mutation.md
└── .github/workflows/
    ├── mutation.yml                 # NEW — path-filtered PR trigger + nightly schedule
    ├── ci.yml                       # UNTOUCHED — deliberately zero diff
    └── release-gates.yml            # UNTOUCHED — deliberately zero diff
```

**`package-lock.json` is not optional.** Both workflows install with `npm ci`, which
fails outright when the lockfile disagrees with `package.json`. The three new dev
dependencies must land in the lockfile in the same commit, and the lockfile is included
in the mutation workflow's `paths` filter (ci-job contract C-10.3).

**The `eslint.config.mjs` edit is defensive, not required.** Both rule blocks in that file
are scoped `files: ['**/*.ts']`, and `settings['boundaries/include']` is `['src/**/*.ts']`,
so `stryker.config.mjs` and `jest.mutation.config.js` are already matched by no rule at
all and pass `npm run lint` untouched. Adding them to `ignores` states the intent
explicitly rather than relying on that absence. Under FR-025 the safe default is to change
lint configuration as little as possible; if this edit is dropped, nothing breaks.

**There are two existing workflows, not one.** `release-gates.yml` runs `verify-uat.sh`,
`npm run test:recovery` and `npm run test:perf` on `workflow_dispatch` and nightly at
`0 3 * * *`. FR-015 and FR-025 apply to it exactly as they apply to `ci.yml`, and the new
workflow's own schedule deliberately avoids that hour.

Defended scope, unchanged from FR-001 — measured at 32 files / 3383 lines:

```text
src/capacity/domain/**          9 files
src/capacity/application/**    14 files
src/shared/money/**             4 files
src/shared/result/**            2 files
src/treasury/handlers/**        2 files
src/treasury/retry/**           1 file
```

**Structure Decision**: root-level tooling configuration, matching where the project
already keeps `jest.config.ts`, `jest.recovery.config.ts`, `jest.perf.config.ts` and
`eslint.config.mjs`. A dedicated `jest.mutation.config.js` is introduced rather than reusing
`jest.config.ts`, because `npm run test:unit` achieves its Docker-free property through a
**command-line path argument** (`jest test/unit`), not through the config — and Stryker
never runs that command. Reusing the existing config would silently pull the
testcontainers-backed suites into every mutant run. See research R-002.

Documentation lands in `docs/testing-mutation.md`, alongside the existing `ASSUMPTIONS.md`,
`kafka-acls.md` and `plans/`, and `README.md` links to it. `README.md` exists as of feature
002-openapi-docs-readme merging in PR #12; an earlier revision of this plan deferred the
link because the file did not yet exist. See R-007, which records both the current decision
and the superseded one.

## Complexity Tracking

> No Constitution Check violations. This section is intentionally empty.
