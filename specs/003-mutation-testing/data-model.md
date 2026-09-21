# Phase 1 Data Model: Mutation Testing

**Feature**: 003-mutation-testing | **Date**: 2026-09-21

This feature persists no database state. The "entities" below are configuration values,
run-time records and generated artefacts. Each is listed with its representation, its
validation rules traced to a requirement, and its lifecycle.

---

## 1. Defended Scope

The set of source paths whose test effectiveness is measured.

| Field | Value | Source |
|---|---|---|
| `mutate` include patterns | `src/capacity/domain/**/*.ts`, `src/capacity/application/**/*.ts`, `src/shared/money/**/*.ts`, `src/shared/result/**/*.ts`, `src/treasury/handlers/**/*.ts`, `src/treasury/retry/**/*.ts` | FR-001 |
| `mutate` exclude patterns | `!src/migrations/**`, `!src/config/**`, `!src/types/**`, `!src/main.ts`, `!**/*.module.ts`, `!**/entities/**`, `!**/dto/**`, `!src/observability/**` | FR-002 |
| Additional exclusion | `!**/*.spec.ts` | Test files are never mutation targets |

**Validation rules**:
- The include list MUST contain exactly the six FR-001 patterns — no more, no fewer.
- The exclude list MUST be retained in full even though it removes **zero** files from the
  six defended directories today (measured 2026-09-21). It guards future additions such as
  a `dto/` folder appearing under `src/capacity/application/`. See research R-009.
- Represented in: `stryker.config.mjs`, key `mutate`.

**Measured size**: 32 files, 3383 lines.

---

## 2. Exercised Test Set

The tests permitted to run during a mutation run.

| Field | Value | Source |
|---|---|---|
| Runner | `jest` | FR-003 |
| Jest config file | `jest.mutation.config.js` | R-002 |
| `roots` | `['<rootDir>/test/unit']` | FR-003 |
| `testRegex` | `.*\.spec\.ts$` | matches the project convention |
| `preset` | `ts-jest` | matches `jest.config.ts` |
| `testEnvironment` | `node` | matches `jest.config.ts` |
| `coverageThreshold` | **absent** | FR-025 — the 80% gate belongs to `test:cov` alone |

**Validation rules**:
- `roots` MUST NOT include `<rootDir>/src` or any path that can reach
  `test/integration`, `test/migration`, `test/contract` or `test/performance`. Exclusion
  MUST be structural (via `roots`), not a `testPathIgnorePatterns` subtraction, so that a
  future suite added under an excluded directory cannot be pulled in by accident.
- The config MUST NOT set `coverageThreshold`; a mutation run collects no coverage report
  and an inherited 80% gate would fail every run.

**Measured content**: 29 suites, 287 tests, 5.99 s.

---

## 3. Altered Variant (mutant)

One deliberate machine-generated change to a single point in a defended source file.

| Field | Type | Notes |
|---|---|---|
| `id` | integer | Assigned per run |
| `mutatorName` | string | e.g. `ConditionalExpression`, `ArithmeticOperator` |
| `fileName` | path | Always inside the Defended Scope |
| `location` | start/end line+column | Satisfies the traceability half of FR-005 |
| `replacement` | string | The altered code |
| `status` | enum | See below |
| `killedBy` | test id list | Populated only when `status = Killed` |
| `statusReason` | string | Populated for `CompileError` and `Timeout` |

**Status enum** — the vocabulary FR-004 counts over:

| Stryker status | Spec vocabulary | Counts against score? |
|---|---|---|
| `Killed` | detected | No |
| `Survived` | undetected | **Yes** |
| `Timeout` | timed out | No — reported separately |
| `NoCoverage` | never executed | **Yes** |
| `CompileError` | discarded before execution | No — excluded from the denominator |
| `Ignored` | suppressed | No — excluded from the denominator |

**State transitions**: `Pending → CompileError` (type-checker rejects it, no test runs) or
`Pending → NoCoverage` (no test touches the line) or `Pending → {Killed | Survived |
Timeout}` (covering tests run). A variant reaches exactly one terminal state per run.

**Validation rule**: a variant may reach `Ignored` **only** via an inline suppression
carrying a written justification (FR-022). A bare suppression is non-conforming.

---

## 4. Effectiveness Score

| Field | Value |
|---|---|
| Definition | `Killed / (Killed + Survived + Timeout + NoCoverage) × 100` |
| Range | 0–100, one decimal place |
| Excluded from denominator | `CompileError`, `Ignored` |

**Validation rules**:
- `NoCoverage` variants MUST count against the score (spec edge case: "a defended file has
  no covering test at all"). Excluding them would let an entirely untested file raise the
  score.
- `Timeout` MUST be reported as its own count even though it does not count against the
  score, so that a machine-speed effect is visible rather than hidden inside the score
  (spec edge case on determinism).

---

## 5. Enforcement Floor

| Field | Value | Source |
|---|---|---|
| `thresholds.break` | `floor(baseline / 5) × 5` | FR-009 |
| `thresholds.low` | above `break`, aspirational | FR-010 |
| `thresholds.high` | above `low`, aspirational | FR-010 |

**Validation rules**:
- `break` MUST NOT be written before a baseline run has produced a real score (FR-008).
- `break` MUST NOT be `100` and MUST NOT be invented (FR-009).
- `low` and `high` MUST NOT affect the exit status (FR-010); they colour the report only.
- Relationship that MUST hold: `break < low <= high <= 100`.

**Lifecycle**: `break` is absent (or `0`) during the baseline run, then written once from
the measurement, then changed only by a deliberate decision recorded in
`docs/ASSUMPTIONS.md`.

---

## 6. Effectiveness Report

| Field | Value | Source |
|---|---|---|
| `reporters` | `['html', 'clear-text', 'progress']` | Deliverables list, FR-005, FR-006 |
| HTML output | `reports/mutation/mutation.html` | Stryker default |
| Version control | **ignored** | FR-007 |
| CI retention | uploaded as a build artefact | FR-018 |

**Validation rule**: the HTML reporter is mandatory — it is the only one that satisfies
FR-005's file + line + original + altered traceability requirement in a browsable form.
`clear-text` gives the terminal summary (FR-004); `progress` gives the liveness signal
(FR-006).

---

## 7. Prior-Run State

| Field | Value | Source |
|---|---|---|
| `incremental` | `true` | FR-012 |
| `incrementalFile` | `.stryker-incremental.json` (repository root) | R-004 |
| Version control | **committed** — the single exception to FR-007 | FR-007, FR-012 |

**Validation rules**:
- The file MUST live at the repository root, not under `reports/`. `reports/` is
  git-ignored wholesale, and a negation rule to un-ignore one file inside an ignored
  directory is fragile; disjoint rules are required instead. See R-004.
- Entries for files that no longer exist MUST NOT be reused. Stryker keys entries by path
  and content hash and discards orphans itself, so a renamed file is fully re-evaluated
  under its new path (spec edge case on rename).

---

## 8. Time Budget

| Field | Value | Source |
|---|---|---|
| Budget | < 10 minutes on the CI runner | FR-012 |
| `coverageAnalysis` | `perTest` | R-003 — the primary lever |
| `concurrency` | Stryker default (derived from available cores) | R-003 |
| `timeoutMS` | `5000` | Bounds the infinite-loop edge case |
| `timeoutFactor` | `1.5` | Absorbs machine-speed variance before declaring a timeout |
| Checker | `typescript` | Discards non-compiling variants before any test runs |

**Validation rule**: if the budget is missed over the full scope, the scope MUST be
narrowed and the omitted directories plus the reason MUST be recorded (FR-013). Silently
exceeding it is non-conforming.
