# Execution Plan: Mutation Testing Gate for Business-Logic Test Effectiveness

**Feature**: 003-mutation-testing | **Date**: 2026-09-21 | **Baseline branch**: `develop`

**Authoritative design artifacts** (read-only inputs; this plan implements them, it does not
revise them):

- `specs/003-mutation-testing/spec.md` — FR-001..FR-026, SC-001..SC-011
- `specs/003-mutation-testing/plan.md` — technical approach, Constitution Check
- `specs/003-mutation-testing/research.md` — R-001..R-009
- `specs/003-mutation-testing/data-model.md`
- `specs/003-mutation-testing/contracts/mutation-command.md` — C-1..C-8
- `specs/003-mutation-testing/contracts/ci-job.md` — C-9..C-13
- `specs/003-mutation-testing/quickstart.md` — Scenarios 1–6
- `specs/003-mutation-testing/tasks.md` — T001..T042

Each task below names the `T0xx` ids it discharges. Where this plan and `tasks.md` differ,
this plan governs, and every such difference is listed under **Key Decisions**.

---

## Goal

`npm run test:mutation` measures how much of the six defended business-logic directories the
unit suite actually detects changes in, enforces a floor derived arithmetically from that
measurement, runs automatically on relevant pull requests and nightly with a downloadable
HTML report, and leaves every pre-existing gate byte-identical.

## Current State

Facts verified in the repository on 2026-09-21. Do not re-derive them; do not trust a
contradicting memory.

**Runtime and toolchain**

- Node `>=22.0.0 <23` (`package.json` `engines`). TypeScript 5.6.3, Jest 29.7.0, ts-jest 29.4.12.
- `package.json` has **no** `"type"` field, so `.js` files are CommonJS and `.mjs` is ESM.
- `tsconfig.json`: `module: commonjs`, `target: ES2023`, `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `declaration: true`, `incremental: true`, `skipLibCheck: true`.
  `include: ["src/**/*", "test/**/*"]`. No `composite`, no project references.
- devDependencies are pinned to **exact versions, no caret or tilde** (e.g. `"jest": "29.7.0"`).
  Match that style.

**Existing npm scripts** — all 19 must survive byte-identical (FR-025):

```
build start start:dev lint format typecheck test test:cov test:unit test:recovery
test:perf migration:run migration:revert migration:generate seed audit:ledger
reconcile docs:verify openapi:export
```

Note `docs:verify` (`./scripts/verify-docs.sh`) and `openapi:export` — added by feature 002 in
PR #12, after the spec text was written. They are inside FR-025's intent regardless.

**`jest.config.ts`** (the default config; do NOT modify it):

```ts
preset: 'ts-jest', testEnvironment: 'node', rootDir: '.',
roots: ['<rootDir>/src', '<rootDir>/test'],
testRegex: '.*\\.spec\\.ts$',
testPathIgnorePatterns: ['/node_modules/', 'test/integration/ledger-recovery\\.spec\\.ts$', 'test/performance/'],
moduleFileExtensions: ['js', 'json', 'ts'],
collectCoverageFrom: ['src/**/*.ts', '!src/main.ts', '!src/**/*.module.ts', '!src/migrations/**'],
coverageDirectory: 'coverage',
coverageThreshold: { global: { branches: 80, functions: 80, lines: 80, statements: 80 } },
```

`npm run test:unit` is `jest test/unit` — it achieves its Docker-free property through a
**command-line path argument**, not through the config. Stryker never runs that command, so
pointing Stryker at `jest.config.ts` would pull the testcontainers suites into every mutant run.
This is the single most important trap in the feature (research R-002).

**`.gitignore`** — exactly six lines, no negation rules, trailing newline present:

```
node_modules/
dist/
coverage/
.env
*.log
.karst/worktrees/
```

**`eslint.config.mjs`** — `ignores` array holds exactly: `dist/**`, `coverage/**`,
`node_modules/**`, `jest.config.ts`, `eslint.config.mjs`, `specs/**`, `docs/**`, `.specify/**`,
`.karst/**`. Both rule blocks are scoped `files: ['**/*.ts']`;
`settings['boundaries/include']` is `['src/**/*.ts']`; `boundaries/no-unknown-files` is `off`.

**`.github/workflows/` holds TWO files, not one.**

`ci.yml`: `on: pull_request` + `push: branches: [develop]`; `concurrency.group:
ci-${{ github.ref }}` with `cancel-in-progress: true`; one job `gate`, `ubuntu-latest`,
`timeout-minutes: 30`, `actions/checkout@v7`, `actions/setup-node@v7` (node 22, `cache: npm`),
then `npm ci`, Lint, Typecheck, Test, Coverage gate, Build.

`release-gates.yml`: job `gates`, `ubuntu-latest`, same checkout/setup-node/npm ci, then
`bash scripts/verify-uat.sh`, `npm run test:recovery`, `npm run test:perf`. Triggers:
`workflow_dispatch` and `schedule: cron: '0 3 * * *'`. **That cron hour is taken.**

**Default branch is `develop`** — verified against the remote with
`gh repo view --json defaultBranchRef` and `git ls-remote --symref origin HEAD`. A local
`origin/HEAD` may be stale; the remote is the authority. This matters because GitHub fires
`schedule` triggers on the default branch only.

**Defended scope** — measured with `find … -name '*.ts'` (note: `ls *.ts` undercounts, these
directories have subdirectories):

| Directory | Files | Lines |
|---|---|---|
| `src/capacity/domain` | 9 | 568 |
| `src/capacity/application` | 14 | 2278 |
| `src/shared/money` | 4 | 175 |
| `src/shared/result` | 2 | 34 |
| `src/treasury/handlers` | 2 | 118 |
| `src/treasury/retry` | 1 | 210 |
| **Total** | **32** | **3383** |

**Unit suite**: 29 suites / 287 tests / ~6.0 s (measured 2026-09-21).

**Stryker is not installed.** `node_modules` contains no `@stryker-mutator/*`. The latest
published version of all three required packages is **10.0.0**; `@stryker-mutator/jest-runner@10.0.0`
peer-depends on `@stryker-mutator/core@10.0.0` exactly, and core declares `engines.node >=22.0.0`.

**No mutation score exists anywhere.** No artifact in this feature predicts one, and none may.

## Target State

```
.
├── stryker.config.mjs               NEW    scope, runner, checker, reporters, thresholds
├── jest.mutation.config.js          NEW    container-free Jest config, roots = test/unit
├── .stryker-incremental.json        NEW    COMMITTED, retained prior-run state
├── .gitignore                       MOD    + reports/ + .stryker-tmp/  (8 lines)
├── eslint.config.mjs                MOD    + 2 ignores entries (defensive only)
├── package.json                     MOD    + 3 devDeps + test:mutation script
├── package-lock.json                MOD    3 devDeps resolved
├── docs/
│   ├── testing-mutation.md          NEW    how to run, read, and act on results
│   └── ASSUMPTIONS.md               MOD    + 4 prose sections
├── README.md                        MOD    2 links
├── specs/003-mutation-testing/
│   └── baseline.md                  NEW    the durable measured-baseline artifact
└── .github/workflows/
    ├── mutation.yml                 NEW
    ├── ci.yml                       UNTOUCHED — zero diff, asserted
    └── release-gates.yml            UNTOUCHED — zero diff, asserted
```

## Scope

### In Scope

- The nine files above.
- One measured baseline run, and the floor derived from it arithmetically.
- One deliberate red step in a scratch worktree, discarded.
- Documentation and the four ASSUMPTIONS entries.

### Out of Scope

- Adding, modifying, weakening, skipping or deleting **any** test (FR-023). Not one.
- Changing any production source file under `src/` (FR-024).
- Refactoring for testability.
- Writing new tests to raise the score. The baseline is what it is; this feature measures and
  fences it, it does not improve it.
- Making the mutation job a required status check (FR-015, C-11.3).
- Touching `ci.yml` or `release-gates.yml` for any reason.

## Key Decisions

1. **Stryker 10.0.0, all three packages, pinned exactly.** `"@stryker-mutator/core": "10.0.0"`,
   `"@stryker-mutator/jest-runner": "10.0.0"`, `"@stryker-mutator/typescript-checker": "10.0.0"`.
   Matches the repo's exact-pin convention and the runner's exact peer requirement. Do not use a
   caret. Do not let `npm install` pick a different version.

2. **The baseline lives in a new file, `specs/003-mutation-testing/baseline.md`.** `tasks.md`
   T012 says to record it into "quickstart.md Scenario 2's result slot"; quickstart.md Scenario 2
   says to write it into `docs/testing-mutation.md` and `docs/ASSUMPTIONS.md`. Neither location
   has a slot, and the two instructions disagree. More importantly, **each task in this plan runs
   in a separate sub-agent with a fresh context**, so the measured number cannot travel in
   session memory — it must be a repository artifact. `baseline.md` is that artifact, with a
   fixed field layout given verbatim in Task 5. Every later task that needs the number reads it
   from there. The documentation tasks then quote it into `docs/testing-mutation.md` and
   `docs/ASSUMPTIONS.md` as quickstart asks, and quickstart.md itself is left unedited.

3. **`tsconfigFile: 'tsconfig.json'`** — as `tasks.md` T007 specifies. The repo's tsconfig sets
   `incremental: true` and `declaration: true` but declares no `composite` and no project
   references, which is what Stryker's typescript-checker actually cannot support. If, and only
   if, the checker exits with an error naming build mode, project references or `composite`, that
   is a blocker to report under the Executor Rules — not a licence to improvise a second tsconfig.

4. **`concurrency` is left at the Stryker default and is not pinned.** A laptop and a 2–4 vCPU
   GitHub runner want different values; pinning one penalises the other. It is tuned only if
   Task 6 finds the run over budget, and only in the order Task 6 gives.

5. **`.stryker-incremental.json` sits at the repository root and is committed; `.stryker-tmp/`
   and `reports/` are ignored.** The original feature request named
   `.stryker-tmp/incremental.json`. `.stryker-tmp/` is Stryker's own sandbox — created and torn
   down around every run — so a file committed inside it is not durable. Root placement also
   keeps the ignore rules disjoint, avoiding a `.gitignore` negation rule. Behaviour is
   unchanged; only the path differs. This deviation is recorded in ASSUMPTIONS (Task 12), which
   Constitution Principle VII requires.

6. **A new workflow file, never a job inside `ci.yml`.** GitHub Actions path filters are
   workflow-level (`on.pull_request.paths`); there is no job-level `paths` key. Filtering inside
   `ci.yml` would suppress its existing `gate` job on every pull request touching no defended
   path — a direct FR-015 violation.

7. **Nightly cron is `0 5 * * *`.** `release-gates.yml` already holds `0 3 * * *`. GitHub queues
   scheduled workflows and delays them under load, so sharing an hour makes both arrive late.

8. **Tasks 1–14 map onto T001–T042.** Grouping is by inseparable logical change, not one task
   per T-id. Every T-id is discharged exactly once and is named in the task that discharges it.

---

## Execution Order

### Task 1: Install the three Stryker dev dependencies and wire the npm script

Discharges T001, T002.

#### Objective

`npm run test:mutation` exists and resolves, `npm ci` succeeds, and all 19 pre-existing scripts
are byte-identical.

#### Files

- `package.json` — MODIFIED: three `devDependencies` entries, one `scripts` entry.
- `package-lock.json` — MODIFIED: generated by the install, committed in the same change.

#### Implementation

1. From the repository root run exactly:

   ```bash
   npm install --save-exact --save-dev \
     @stryker-mutator/core@10.0.0 \
     @stryker-mutator/jest-runner@10.0.0 \
     @stryker-mutator/typescript-checker@10.0.0
   ```

   `--save-exact` is required: the repo pins devDependencies without a caret, and the jest-runner
   peer-depends on `@stryker-mutator/core@10.0.0` exactly.

2. Confirm `package.json` now contains, in the `devDependencies` object (npm keeps it
   alphabetically sorted; let it):

   ```json
   "@stryker-mutator/core": "10.0.0",
   "@stryker-mutator/jest-runner": "10.0.0",
   "@stryker-mutator/typescript-checker": "10.0.0",
   ```

3. Add exactly one entry to the `scripts` object, placed immediately after the existing
   `"test:perf"` line so the test family stays contiguous:

   ```json
   "test:mutation": "stryker run stryker.config.mjs",
   ```

4. Verify no other `scripts` entry changed:

   ```bash
   git diff package.json
   ```

   The diff must show only the three devDependency additions and the one script addition. If any
   existing script line appears in the diff — reordered, reindented or reformatted — revert it.

#### Constraints

- Do NOT modify, reorder or reformat any existing `scripts` entry (FR-025). `docs:verify` and
  `openapi:export` are easy to overlook and both are merge gates.
- Do NOT use `^` or `~` on the three new versions.
- Do NOT add any dependency beyond these three.
- Do NOT edit `package-lock.json` by hand; let npm write it.

#### Edge Cases

- If `npm install` resolves a version other than 10.0.0 for any of the three, the pin was not
  honoured — correct `package.json` to the exact strings above and re-run `npm install` so the
  lockfile agrees.
- If `npm install` reports a peer dependency conflict, report it as a blocker. Do not pass
  `--force` or `--legacy-peer-deps`; both would produce a lockfile that `npm ci` treats
  differently in CI than locally.

#### Verification

```bash
npm ci
npm run lint
npm run typecheck
npm run test:unit
node -e "const s=require('./package.json').scripts; if(s['test:mutation']!=='stryker run stryker.config.mjs') throw new Error('script wrong'); console.log('ok')"
git diff --stat package.json package-lock.json
```

Expected:

- `npm ci` exits 0 — proves the lockfile and `package.json` agree.
- `lint`, `typecheck`, `test:unit` behave exactly as before (test:unit: 29 suites, 287 tests).
- The node check prints `ok`.
- Only `package.json` and `package-lock.json` appear in the diff.

`npm run test:mutation` is expected to FAIL at this point — `stryker.config.mjs` does not exist
yet. That is correct and is fixed in Task 3.

#### Completion Criteria

- [ ] Three devDependencies present at exactly `10.0.0`, no caret or tilde.
- [ ] `test:mutation` script present with the exact command string.
- [ ] No pre-existing script entry changed in any way.
- [ ] `package-lock.json` updated by npm and `npm ci` exits 0.
- [ ] `lint`, `typecheck`, `test:unit` unchanged.

---

### Task 2: Add the ignore entries to `.gitignore` and `eslint.config.mjs`

Discharges T003, T004.

#### Objective

Generated mutation output is ignored, the committed incremental file is not, and the two new
root config files are explicitly listed as lint-ignored.

#### Files

- `.gitignore` — MODIFIED: two lines appended.
- `eslint.config.mjs` — MODIFIED: two entries appended to the `ignores` array.

#### Implementation

1. `.gitignore` currently holds exactly six lines, in this order, with a trailing newline:

   ```
   node_modules/
   dist/
   coverage/
   .env
   *.log
   .karst/worktrees/
   ```

   Append exactly two lines, so the file becomes eight:

   ```
   reports/
   .stryker-tmp/
   ```

   Do NOT add `.stryker-incremental.json` — it is deliberately tracked (FR-012, research R-004).
   Do NOT introduce a negation (`!`) rule; the file has none and the root placement of the
   incremental file exists precisely so none is needed.

2. In `eslint.config.mjs`, the first exported object's `ignores` array currently ends with
   `'.karst/**',`. Append two entries after it:

   ```js
   'stryker.config.mjs',
   'jest.mutation.config.js',
   ```

   Change nothing else in that file — no rule, no `settings`, no `files` scope.

#### Constraints

- The eslint edit is **defensive only**. Both rule blocks are scoped `files: ['**/*.ts']` and
  `settings['boundaries/include']` is `['src/**/*.ts']`, so the two new files already match no
  rule and already pass `npm run lint`. The entry states the intent rather than relying on that
  absence. Add nothing else to the array.
- Do not reorder existing `ignores` entries.

#### Edge Cases

- If `.gitignore` does not hold exactly the six lines listed above, the repository state
  contradicts this plan — stop and report it rather than guessing at a merge.

#### Verification

```bash
wc -l < .gitignore
npm run lint
git check-ignore -v reports/mutation/mutation.html .stryker-tmp/x
git check-ignore .stryker-incremental.json; echo "exit=$?"
```

Expected:

- `.gitignore` is 8 lines.
- `npm run lint` exits 0 with the same output as before.
- Both `git check-ignore -v` paths report a match.
- `git check-ignore .stryker-incremental.json` exits **1** (not ignored) — this is the point.

#### Completion Criteria

- [ ] `.gitignore` is exactly 8 lines, `reports/` and `.stryker-tmp/` last, no negation rule.
- [ ] `.stryker-incremental.json` is NOT ignored.
- [ ] `eslint.config.mjs` `ignores` gained exactly two entries; nothing else changed.
- [ ] `npm run lint` unchanged.

---

### Task 3: Create `jest.mutation.config.js` and prove it excludes the container suites

Discharges T005, T006.

#### Objective

A Jest config that structurally cannot run a container-dependent test, verified before Stryker
ever uses it.

#### Files

- `jest.mutation.config.js` — NEW, repository root.

#### Implementation

Create the file with exactly this content:

```js
/**
 * Jest configuration used only by Stryker (`npm run test:mutation`).
 *
 * `roots` is restricted to `test/unit` as a STRUCTURAL exclusion of the
 * container-dependent suites, not a subtractive ignore pattern. `npm run test:unit`
 * gets its Docker-free property from a command-line path argument (`jest test/unit`),
 * which Stryker never runs — so reusing `jest.config.ts` here would silently pull the
 * testcontainers-backed suites into every mutant run. See research R-002.
 *
 * `coverageThreshold` is deliberately omitted: the 80% global gate belongs to
 * `npm run test:cov` alone and must not be evaluated per mutant.
 *
 * Plain CommonJS `.js` rather than `.ts` so Stryker's jest-runner need not resolve a
 * TypeScript config. `package.json` declares no `"type"`, so `.js` is CommonJS.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/test/unit'],
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
};
```

#### Constraints

- Do NOT modify `jest.config.ts`, `jest.recovery.config.ts` or `jest.perf.config.ts`.
- Do NOT add `coverageThreshold`, `collectCoverageFrom` or `coverageDirectory`.
- Do NOT express the exclusion as `testPathIgnorePatterns`; it must be `roots`.

#### Edge Cases

- A unit spec that transitively imports testcontainers would still be listed by `--listTests`.
  Verification below catches only path-based leakage; if the later baseline run in Task 5 hangs
  or logs testcontainers, Postgres, Redis or Redpanda, that is contract C-5.3 broken — stop and
  report, do not add an ignore pattern to paper over it.

#### Verification

```bash
npx jest --config jest.mutation.config.js --listTests | sort > /tmp/mutation-tests.txt
wc -l < /tmp/mutation-tests.txt
grep -cE 'test/(integration|migration|contract|performance)/' /tmp/mutation-tests.txt
```

Expected:

- The list is non-empty and every path lies under `test/unit/`.
- The `grep -c` prints `0`. Any non-zero count means the config is wrong; fix it before
  proceeding. Do not continue to Task 4 with a non-zero count.

#### Completion Criteria

- [ ] `jest.mutation.config.js` exists at the repository root with the content above.
- [ ] `--listTests` lists only paths under `test/unit/`.
- [ ] Zero paths under `test/integration/`, `test/migration/`, `test/contract/`, `test/performance/`.
- [ ] No existing jest config file modified.

---

### Task 4: Create `stryker.config.mjs` with scope and reporters, and verify the resolved file set

Discharges T007, T008, T009.

#### Objective

Stryker is configured over exactly the 32 defended files, with **no threshold block** — the
floor is measured in Task 5 and installed in Task 7.

#### Files

- `stryker.config.mjs` — NEW, repository root.

#### Implementation

Create the file with exactly this content:

```js
// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: 'npm',

  // Scope: the six defended business-logic directories (FR-001), then the eight
  // exclusions (FR-002). The exclusions remove zero files from within these six
  // directories as measured on 2026-09-21; they are kept because the globs are
  // evaluated against future contents and a `dto/` folder under
  // `src/capacity/application/` is plausible. See research R-009.
  mutate: [
    'src/capacity/domain/**/*.ts',
    'src/capacity/application/**/*.ts',
    'src/shared/money/**/*.ts',
    'src/shared/result/**/*.ts',
    'src/treasury/handlers/**/*.ts',
    'src/treasury/retry/**/*.ts',
    '!src/migrations/**',
    '!src/config/**',
    '!src/types/**',
    '!src/main.ts',
    '!**/*.module.ts',
    '!**/entities/**',
    '!**/dto/**',
    '!src/observability/**',
  ],

  testRunner: 'jest',
  jest: {
    // NOT jest.config.ts — that config's `roots` include test/integration, which is
    // testcontainers-backed. See jest.mutation.config.js and research R-002.
    configFile: 'jest.mutation.config.js',
  },

  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',

  coverageAnalysis: 'perTest',

  reporters: ['html', 'clear-text', 'progress'],
  htmlReporter: { fileName: 'reports/mutation/mutation.html' },

  incremental: true,
  incrementalFile: '.stryker-incremental.json',

  timeoutMS: 10000,

  // `concurrency` is deliberately left at the Stryker default. A laptop and a 2-4 vCPU
  // GitHub runner want different values and pinning one penalises the other.

  // NO `thresholds` block yet. The floor is derived from the measured baseline in
  // specs/003-mutation-testing/baseline.md and installed afterwards. Writing a guessed
  // number here violates FR-009.
};
```

#### Constraints

- Do NOT add a `thresholds` block in this task. That is Task 7's job and depends on a number
  that does not yet exist.
- Do NOT set `concurrency`.
- Do NOT point `jest.configFile` at `jest.config.ts`.
- Do NOT add, remove or reword any glob. The six patterns and eight exclusions are fixed by
  FR-001 and FR-002.

#### Edge Cases

- If the resolved file count is not 32, a glob is wrong. Reconcile before measuring anything — a
  baseline over the wrong file set produces a floor that fences the wrong thing.

#### Verification

```bash
find src/capacity/domain src/capacity/application src/shared/money src/shared/result \
     src/treasury/handlers src/treasury/retry -name '*.ts' | wc -l
find src/capacity/domain src/capacity/application src/shared/money src/shared/result \
     src/treasury/handlers src/treasury/retry -name '*.ts' -exec cat {} + | wc -l
for d in src/capacity/domain src/capacity/application src/shared/money src/shared/result \
         src/treasury/handlers src/treasury/retry; do
  printf '%s %s\n' "$d" "$(find "$d" -name '*.ts' | wc -l | tr -d ' ')"
done
npm run lint
```

Expected:

- File count `32`, line count `3383`.
- Per-directory: `domain 9`, `application 14`, `money 4`, `result 2`, `handlers 2`, `retry 1`.
- `npm run lint` exits 0, unchanged (the file is in the `ignores` array from Task 2).

#### Completion Criteria

- [ ] `stryker.config.mjs` exists with the content above.
- [ ] No `thresholds` key present anywhere in it.
- [ ] Scope measures 32 files / 3383 lines with the per-directory distribution above.
- [ ] `npm run lint` unchanged.

---

### Task 5: Run the baseline and record it in `specs/003-mutation-testing/baseline.md`

Discharges T010, T011, T012. **This is the task the whole feature pivots on.**

#### Objective

A real, measured, verbatim-recorded baseline exists as a repository artifact that later tasks
read. No number in this feature may be invented, estimated, or carried in session memory.

#### Files

- `specs/003-mutation-testing/baseline.md` — NEW.
- `.stryker-incremental.json` — NEW, generated by the run (committed in Task 6).

#### Implementation

1. **Precondition.** Run `npm run test:unit`. It MUST be green. A mutation run against an
   already-red suite reports a meaningless score, and the spec's edge case requires reporting the
   broken suite rather than a number. The expected size is 29 suites / 287 tests / ~6.0 s
   (measured 2026-09-21). If the suite is red, stop and report the failing suite — do not
   proceed, and do not fix the test (FR-023 forbids modifying tests).

2. **Run the baseline, timed end to end:**

   ```bash
   time npm run test:mutation 2>&1 | tee /tmp/stryker-baseline.log
   ```

   Do not edit any configuration while the run is in flight. The run has no `thresholds` block,
   so its exit status is not yet meaningful — **the score is what matters**.

3. **Create `specs/003-mutation-testing/baseline.md`** with exactly this layout, replacing each
   `<…>` with the value read verbatim from the run's own terminal summary. Do not round, do not
   estimate, do not reuse a number from any other document.

   ```markdown
   # Measured Baseline: Mutation Testing

   **Feature**: 003-mutation-testing | **Measured**: <YYYY-MM-DD>

   This file is the single authoritative record of the FR-008 baseline. Every threshold, every
   documentation figure and every assumption entry in this feature derives from the numbers
   below. They were produced by one real run, not estimated. Nothing in this feature predicted
   them, and nothing should.

   ## The run

   - Command: `npm run test:mutation`
   - Stryker: 10.0.0
   - Configuration: `stryker.config.mjs` with **no `thresholds` block**
   - Scope: 32 files / 3383 lines across the six FR-001 directories
   - Unit suite at time of measurement: <N> suites / <N> tests
   - Wall-clock time: <Xm Ys>
   - Machine: <local workstation | CI runner>

   ## Result

   | Metric | Value |
   |---|---|
   | Mutation score | <NN.N>% |
   | Killed (detected) | <N> |
   | Survived (undetected) | <N> |
   | Timeout (timed out) | <N> |
   | NoCoverage (never executed) | <N> |
   | CompileError | <N> |
   | Ignored | <N> |
   | Total variants | <N> |

   ## Derived floor

   Arithmetic per contract C-2.5, applied to the score above:

   - `break` = floor(<NN.N> / 5) x 5 = **<N>**
   - `low`  = break + 5  = **<N>**
   - `high` = break + 10 = **<N>**

   If `break + 10` exceeds 100, `high` is 100 and `low` is 95.

   Only `break` governs exit status (FR-010, contract C-2.4).
   ```

4. Fill the **Derived floor** section in this same task, showing the arithmetic. Later tasks read
   these three numbers rather than recomputing them.

#### Constraints

- Do NOT modify any file under `src/` or `test/` — not to make the score nicer, not for any
  reason (FR-023, FR-024).
- Do NOT add a `thresholds` block during this task.
- Do NOT edit `specs/003-mutation-testing/quickstart.md`; the baseline lives in `baseline.md`.
- Record `CompileError` and `Ignored` even when zero. A non-zero `CompileError` count means the
  TypeScript checker rejected variants and is worth knowing about later.

#### Edge Cases

- **The run logs testcontainers, Postgres, Redis or Redpanda** → `jest.mutation.config.js` is not
  constraining the runner. Contract C-5.3 is broken. Stop and report; do not add ignore patterns.
- **The typescript-checker errors naming build mode, project references or `composite`** → stop
  and report as a blocker. Do not create a second tsconfig on your own authority.
- **A high `Timeout` count** → record it as measured. Timeouts are reported as their own count,
  distinct from the score, precisely so machine-speed effects stay visible (contract C-3.3). Do
  not tune `timeoutMS` in this task; that is Task 6's decision and only if over budget.
- **The score is startlingly low or high** → record it anyway. There is no expected value.

#### Verification

```bash
test -f specs/003-mutation-testing/baseline.md && echo "baseline recorded"
grep -E 'Mutation score \| [0-9]+\.[0-9]+%' specs/003-mutation-testing/baseline.md
grep -E '`break` = floor' specs/003-mutation-testing/baseline.md
test -f .stryker-incremental.json && echo "incremental written"
grep -icE 'testcontainers|postgres|redis|redpanda' /tmp/stryker-baseline.log
```

Expected:

- `baseline.md` exists with a concrete percentage to one decimal place, four counts, and the
  three derived values with the arithmetic shown.
- `.stryker-incremental.json` exists at the repository root.
- The container grep prints `0`.

#### Completion Criteria

- [ ] `npm run test:unit` was green before the baseline ran.
- [ ] One full `npm run test:mutation` completed and its output was captured.
- [ ] `baseline.md` records the score to one decimal place and all counts verbatim.
- [ ] The `break`/`low`/`high` arithmetic is written out in `baseline.md`.
- [ ] No file under `src/` or `test/` was modified.

---

### Task 6: Verify the run's container-free, traceable, non-mutating and on-budget properties

Discharges T013, T014, T015, T016, T017.

#### Objective

The four properties the baseline's credibility rests on are each proven empirically, and the
incremental file is committed.

#### Files

- `.stryker-incremental.json` — committed (already generated by Task 5).
- `stryker.config.mjs` — MODIFIED **only if** the run is over budget, per step 4.
- `specs/003-mutation-testing/baseline.md` — MODIFIED: wall-clock figure confirmed.

#### Implementation

1. **No-container proof (T013).** Stop the Docker daemon entirely. Confirm nothing is reachable:

   ```bash
   docker context ls
   docker info    # expect this to fail
   npm run test:mutation
   ```

   It MUST complete normally. If it hangs or errors on a container, `jest.mutation.config.js` is
   not constraining the runner — stop and report. Restart Docker afterwards.

2. **Report traceability (T014).** Open `reports/mutation/mutation.html`. Filter to **Survived**.
   Pick three entries at random and confirm each shows: source file, line number, original code,
   altered code — and that the file path lies inside the six defended directories. 100%
   traceability is SC-006; three samples failing means the reporter is misconfigured.

3. **Non-mutation proof (T015).**

   ```bash
   git status --porcelain
   ```

   No file under `src/` or `test/` may appear as modified. The only expected entries are the
   ignored `reports/` and `.stryker-tmp/` (which should not appear at all, being ignored) plus
   untracked `.stryker-incremental.json`. A modified source or test file means the run mutated in
   place rather than in its sandbox — stop and investigate.

4. **Budget (T016).** Compare Task 5's measured wall-clock time against the 10-minute budget.
   - Under budget → record the figure in `baseline.md` and proceed.
   - Over budget → tune in **exactly this order**, re-measuring after each step, and stop as soon
     as it fits: (a) raise `concurrency` in `stryker.config.mjs`; (b) lower `timeoutMS`;
     (c) confirm `coverageAnalysis: 'perTest'` is actually in effect. Only if all three fail may
     scope be narrowed — and then the dropped directories and the reason MUST be named in
     `docs/testing-mutation.md` in Task 11. Silently exceeding the budget is non-conforming
     (FR-013, contract C-8.2). If scope is narrowed, re-run Task 5's measurement and update
     `baseline.md`: the floor must derive from the scope actually being fenced.

5. **Commit the incremental file (T017).**

   ```bash
   git add .stryker-incremental.json
   ```

   It is deliberately tracked while `reports/` and `.stryker-tmp/` are ignored.

#### Constraints

- Do not tune `concurrency` or `timeoutMS` unless step 4 finds the run over budget.
- Do not narrow scope before exhausting (a), (b) and (c) in that order.
- Do not `git add` `reports/` or `.stryker-tmp/`.

#### Edge Cases

- **`docker info` succeeds because a rootless or remote context is still active** → the proof is
  void. Ensure every context is unreachable before running, or the test proves nothing.
- **`reports/` or `.stryker-tmp/` appears in `git status`** → the `.gitignore` entries from Task 2
  are missing or misspelled. Fix `.gitignore`, do not `git add -f` around it.

#### Verification

```bash
docker info >/dev/null 2>&1 && echo "DOCKER STILL UP - proof void" || echo "docker down, proof valid"
git status --porcelain -- src test
git status --porcelain | grep -E 'reports/|\.stryker-tmp/' ; echo "grep exit=$?"
git status --porcelain -- .stryker-incremental.json
```

Expected:

- The Docker check printed `docker down, proof valid` at the time the run was made.
- `git status --porcelain -- src test` is **empty**.
- The `reports/`/`.stryker-tmp/` grep exits `1` (no match).
- `.stryker-incremental.json` shows as staged (`A `).

#### Completion Criteria

- [ ] A full mutation run completed with the Docker daemon down.
- [ ] Three Survived entries each show file, line, original and altered code, all inside scope.
- [ ] `git status --porcelain -- src test` is empty.
- [ ] Wall-clock time recorded in `baseline.md` and either under 10 minutes or tuned per step 4.
- [ ] `.stryker-incremental.json` staged; `reports/` and `.stryker-tmp/` are not.

---

### Task 7: Derive and install the threshold, and prove the green path

Discharges T018, T019, T020, T021.

#### Objective

The measured baseline becomes an enforced floor, and the unmodified repository passes it.

#### Files

- `stryker.config.mjs` — MODIFIED: one `thresholds` block added.

#### Implementation

1. **Read the three numbers from `specs/003-mutation-testing/baseline.md`**, section
   **Derived floor**. Do not recompute from memory and do not read them from any other document.
   That file was written by Task 5 and is the only authoritative source. If it is missing or has
   an unfilled `<…>` placeholder, Task 5 did not complete — stop and report.

2. The arithmetic, restated so it can be checked (contract C-2.5):
   - `break` = the measured score rounded **down** to the nearest multiple of 5
   - `low` = `break + 5`
   - `high` = `break + 10`
   - if `break + 10` exceeds 100, then `high` = 100 and `low` = 95

3. Add the block to `stryker.config.mjs`, immediately after the `timeoutMS` line:

   ```js
   // Derived arithmetically from the measured baseline in
   // specs/003-mutation-testing/baseline.md, per contract C-2.5. `break` alone governs
   // exit status; `high` and `low` are report colouring and aspiration only (FR-010).
   thresholds: { high: <high>, low: <low>, break: <break> },
   ```

4. **Cross-check (T020).** Read the value now in `stryker.config.mjs` and the number recorded in
   `baseline.md`. The configured `break` MUST equal the recorded score floored to a multiple of
   5, and `break < low <= high <= 100` must hold. A mismatch is SC-009 failing.

5. **Green path (T021).**

   ```bash
   npm run test:mutation
   echo $?
   ```

   Exit status MUST be `0`. Since the floor is the baseline floored to a multiple of 5, the
   unmodified repository is at or above it by construction — a non-zero exit here means the
   derivation in step 2 is wrong.

#### Constraints

- Do NOT invent a number. Do NOT use 100 (FR-009).
- Do NOT let `high` or `low` affect exit status; only `break` does (FR-010, C-2.4).
- Do NOT modify any test or source file to make the run pass.

#### Edge Cases

- **Measured score is exactly a multiple of 5** (e.g. 75.0) → `break` = 75. Flooring an exact
  multiple leaves it unchanged; it does not drop to 70.
- **Measured score ≥ 90** → `break + 10` may exceed 100; apply the cap: `high` = 100, `low` = 95.
- **Exit is non-zero on the unmodified repository** → the derivation is wrong, or the second run
  scored lower than the baseline because of a timeout flake. Re-read `baseline.md`, re-check the
  arithmetic, and if the arithmetic is right, report the flake with both runs' counts rather than
  lowering the floor to make it pass.

#### Verification

```bash
grep -n 'thresholds' stryker.config.mjs
node --input-type=module -e "
  const c = (await import('./stryker.config.mjs')).default;
  const t = c.thresholds;
  if (!t) throw new Error('no thresholds block');
  if (!(t.break < t.low && t.low <= t.high && t.high <= 100)) throw new Error('ordering wrong: ' + JSON.stringify(t));
  if (t.break % 5 !== 0) throw new Error('break not a multiple of 5');
  console.log('thresholds ok', JSON.stringify(t));
"
npm run test:mutation; echo "exit=$?"
```

Expected:

- The node check prints `thresholds ok {...}`.
- `npm run test:mutation` prints `exit=0`.

#### Completion Criteria

- [ ] `thresholds` block present with all three values.
- [ ] `break` equals the `baseline.md` score floored to a multiple of 5.
- [ ] `break < low <= high <= 100`.
- [ ] Unmodified repository exits `0`.
- [ ] No test or source file modified.

---

### Task 8: The red step — prove the gate can actually fail, in a scratch worktree

Discharges T022, T023, T024. **Mandatory. This is why Constitution Principle VI passes for this
feature.**

#### Objective

The gate is observed failing, with actionable output, and the weakened test is provably gone.

#### Files

- A scratch git worktree, created and destroyed inside this task. **No repository file is
  modified.**

#### Implementation

1. Confirm the working tree is clean of test modifications before starting:

   ```bash
   git status --porcelain -- src test
   ```

   Must be empty.

2. Create a scratch worktree **outside** the working tree:

   ```bash
   git worktree add /tmp/mutation-redstep HEAD
   cd /tmp/mutation-redstep
   npm ci
   ```

3. In the scratch copy **only**, pick one unit test under `test/unit/` that covers the defended
   scope — a spec exercising `src/shared/money/` or `src/capacity/domain/` is the clearest
   choice — and delete its assertions (the `expect(...)` calls), leaving the test body otherwise
   intact so it still passes. The point is a test that runs but checks nothing.

4. Run the gate in the scratch copy:

   ```bash
   npm run test:mutation
   echo $?
   ```

   Expected: **non-zero**, with output naming both the achieved score and the floor it missed
   (T022, contract C-2.2, SC-004). A failure that reports only "failed" without both numbers is
   not actionable — report that as a defect in the configuration.

   If the exit is `0`, removing one test's assertions did not move the score below the floor.
   Delete assertions from a second and third defended-scope spec and re-run, until it fails. The
   gate must be seen to fail; a gate never observed failing is not a gate.

5. Destroy the scratch copy completely:

   ```bash
   cd /Users/nd/Work/projects/invoice-reservation
   git worktree remove --force /tmp/mutation-redstep
   git worktree prune
   ```

#### Constraints

- The weakened test MUST NOT reach a commit, on any branch, ever. FR-023 forbids weakening any
  test; this copy exists solely to prove the gate fires.
- Do NOT perform this in the working tree, even "just for a moment".
- Do NOT commit anything between steps 3 and 5.
- Do NOT lower the threshold to make the gate fail; weaken the test instead.

#### Edge Cases

- **`git worktree add` fails because `/tmp/mutation-redstep` exists** → remove the stale
  directory and prune first; do not fall back to editing in the working tree.
- **`npm ci` in the worktree is slow or fails** → the worktree has no `node_modules`; `npm ci` is
  required. If it fails, report it rather than symlinking `node_modules` from the main tree,
  which would let the scratch copy write into the main tree's state.
- **The process is interrupted between steps 3 and 5** → the very first action on resuming is
  step 5. Verify with `git worktree list` before anything else.

#### Verification

```bash
cd /Users/nd/Work/projects/invoice-reservation
git worktree list
git status --porcelain -- src test
ls -d /tmp/mutation-redstep 2>/dev/null && echo "SCRATCH STILL PRESENT" || echo "scratch gone"
```

Expected:

- `git worktree list` shows only the main worktree — no `/tmp/mutation-redstep` entry.
- `git status --porcelain -- src test` is **empty**.
- The `ls` prints `scratch gone`.

#### Completion Criteria

- [ ] A run with weakened assertions exited **non-zero**.
- [ ] That run's output named both the achieved score and the floor.
- [ ] The scratch worktree is removed and pruned.
- [ ] `git status --porcelain -- src test` is empty.
- [ ] Nothing was committed while a weakened test existed on disk.

---

### Task 9: Create `.github/workflows/mutation.yml`

Discharges T025, T026, T027, T028, T029, T030, T031.

#### Objective

A new, separate workflow that runs the gate on relevant pull requests and nightly, keeps the
report whether or not the run passes, and blocks nothing.

#### Files

- `.github/workflows/mutation.yml` — NEW.

#### Implementation

Create the file with exactly this content:

```yaml
name: Mutation

# A SEPARATE workflow file, deliberately not a second job in ci.yml. GitHub Actions
# path filters are workflow-level (`on.pull_request.paths`); there is no job-level
# `paths` key. Filtering inside ci.yml would suppress its existing `gate` job on every
# pull request touching no defended path — a direct FR-015 violation. See contract C-9.1
# and research R-005.
on:
  pull_request:
    paths:
      - 'src/capacity/domain/**'
      - 'src/capacity/application/**'
      - 'src/shared/money/**'
      - 'src/shared/result/**'
      - 'src/treasury/handlers/**'
      - 'src/treasury/retry/**'
      - 'stryker.config.mjs'
      - 'jest.mutation.config.js'
      - 'package.json'
      # The lockfile is listed explicitly: a Stryker patch bump moves only
      # package-lock.json, changing the gate's behaviour while touching no other
      # filtered path, and would otherwise slip through unexercised (contract C-10.3).
      - 'package-lock.json'
  schedule:
    # 05:00 UTC, NOT 03:00 — release-gates.yml already occupies that hour. GitHub queues
    # scheduled workflows and delays them under load, so two nightly runs on the same
    # hour compete for the same runner allowance and both arrive late (contract C-10.4).
    # Note: schedule triggers fire on the default branch (`develop`) only.
    - cron: '0 5 * * *'

# Distinct from ci.yml's `ci-${{ github.ref }}`, which carries cancel-in-progress: true.
# A shared group would let a mutation run cancel, or be cancelled by, an unrelated CI run
# on the same ref (contract C-9.4).
concurrency:
  group: mutation-${{ github.ref }}
  cancel-in-progress: true

jobs:
  mutation:
    runs-on: ubuntu-latest
    # Above the 10-minute budget so a merely slow run still reports, well below ci.yml's
    # 30 so a runaway fails fast.
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v7

      - uses: actions/setup-node@v7
        with:
          node-version: '22'
          cache: npm

      - run: npm ci

      - name: Mutation testing
        run: npm run test:mutation

      # always(), not the default. A failing run is exactly when the surviving variants
      # need inspecting, so the artefact must survive a threshold failure (FR-018,
      # contract C-12, SC-010).
      - name: Upload mutation report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: mutation-report
          path: reports/mutation/
          if-no-files-found: error
```

#### Constraints

- Declare **no** `needs:` on any job, and add none to any existing workflow (FR-015, C-11.2).
- Declare **no** service container and **no** repository secret. The run is container-free by
  construction and has nothing to leak (contract C-13, Constitution Principle V).
- Do NOT configure this job as a required status check. That is a repository setting and outside
  this feature (C-11.3).
- Do NOT touch `ci.yml` or `release-gates.yml`.

#### Edge Cases

- **A pull request touches only `docs/**`** → this workflow must not run at all, while `ci.yml`'s
  `gate` job still does. That is the design, verified in Task 10.
- **No nightly run appears on a feature branch** → correct behaviour, not a defect. GitHub fires
  `schedule` on the default branch only.

#### Verification

```bash
python3 -c "import yaml,sys; d=yaml.safe_load(open('.github/workflows/mutation.yml')); print('parsed ok'); print('cron:', d[True]['schedule']); print('concurrency:', d['concurrency']['group']); print('needs' in str(d))"
grep -n 'needs:' .github/workflows/mutation.yml; echo "needs grep exit=$?"
grep -n "cron: '0 3" .github/workflows/mutation.yml; echo "forbidden cron grep exit=$?"
git diff -- .github/workflows/ci.yml .github/workflows/release-gates.yml
```

Expected:

- The YAML parses; cron is `0 5 * * *`; concurrency group is `mutation-${{ github.ref }}`.
- The `needs:` grep exits `1` (no match).
- The `'0 3` grep exits `1` (no match).
- The workflow diff is **empty**.

#### Completion Criteria

- [ ] `.github/workflows/mutation.yml` exists and parses as valid YAML.
- [ ] Ten `paths` entries, including `package-lock.json`.
- [ ] `cron: '0 5 * * *'`, not `'0 3 * * *'`.
- [ ] `concurrency.group` is exactly `mutation-${{ github.ref }}`.
- [ ] `timeout-minutes: 20`; `checkout@v7`; `setup-node@v7` node 22 with npm cache.
- [ ] Upload step carries `if: always()`.
- [ ] No `needs:`, no service container, no secret.
- [ ] `git diff` on both existing workflows is empty.

---

### Task 10: Prove the automation's triggers and non-interference on GitHub

Discharges T032, T033, T034, T035, T036.

#### Objective

The workflow's behaviour is observed on the real platform, not merely asserted in YAML.

#### Files

None modified. This task observes.

#### Implementation

1. **Zero-diff proof (T032).** The cleanest available evidence for FR-015:

   ```bash
   git diff -- .github/workflows/ci.yml .github/workflows/release-gates.yml
   ```

   MUST be empty. The repository holds **two** existing workflows, not one, and FR-015 covers
   both (contracts C-9.2 and C-9.2a).

2. **Positive trigger (T033).** Open a pull request changing one file under
   `src/shared/money/**`. Confirm the `mutation` job executes.

3. **Negative trigger (T034).** Open a pull request changing only files under `docs/**`. Confirm
   the `mutation` job does **not** execute, while `ci.yml`'s `gate` job does.

4. **Isolation under failure (T035).** Using a run that fails the threshold, confirm the
   pre-existing lint, type-check, test, coverage and build gates report exactly what they would
   have reported before this feature existed.

5. **Artefact retrieval (T036).** Download `mutation-report` from **both** a passing run and a
   failing run, confirming `if: always()` holds in practice and not only in the YAML.

#### Constraints

- Do not make the mutation job required in branch protection.
- Do not modify `ci.yml` or `release-gates.yml` to "help" any of these checks pass.

#### Edge Cases

- **Step 4 needs a failing run** and the repository legitimately passes. Reuse the observation
  from Task 8's red step rather than weakening a test on a branch, or push a scratch branch whose
  only change lowers `thresholds.break`'s complement — simplest is to temporarily raise `break`
  above the measured score **on a throwaway branch that is never merged**, observe, then delete
  the branch. Never weaken a test on a pushed branch.

#### Verification

```bash
git diff -- .github/workflows/ci.yml .github/workflows/release-gates.yml; echo "diff exit=$?"
gh run list --workflow=mutation.yml --limit 5
gh run list --workflow=ci.yml --limit 5
```

Expected:

- The diff is empty.
- The mutation workflow appears for the money-file pull request and does not appear for the
  docs-only one.
- `ci.yml`'s `gate` appears for both.

#### Completion Criteria

- [ ] `git diff` on both existing workflows is empty.
- [ ] A pull request under `src/shared/money/**` ran the mutation job.
- [ ] A docs-only pull request did NOT run it, while `gate` did.
- [ ] Existing gates reported identically during a mutation failure.
- [ ] `mutation-report` downloaded from both a passing and a failing run.

---

### Task 11: Write `docs/testing-mutation.md`

Discharges T037, T038, T039.

#### Objective

A developer unfamiliar with mutation testing can act on a surviving variant without further help
(SC-011), and three correct-but-surprising behaviours are documented so they are not filed as
defects.

#### Files

- `docs/testing-mutation.md` — NEW.

#### Implementation

Write the file covering, in this order:

1. **How to run locally** — `npm run test:mutation`, no Docker required, expected wall-clock time
   quoting Task 6's measured figure.
2. **Where the report is written** — `reports/mutation/mutation.html`, git-ignored.
3. **How to read an undetected variant** — filter to Survived; each entry shows source file, line
   number, original code and altered code.
4. **The decision rule** — add a test when the altered code produces genuinely different
   behaviour no assertion checks; suppress only when the altered code is provably equivalent to
   the original.
5. **Why the floor sits where it does** — quote the baseline score from
   `specs/003-mutation-testing/baseline.md` verbatim, and show the `break`/`low`/`high`
   arithmetic from the same file.
6. **The suppression rule (T039), stated explicitly**: every `// Stryker disable` MUST carry an
   inline written justification, on the same line or immediately above. A bare suppression is
   forbidden and is a review-blocking defect — suppression without justification is
   indistinguishable from hiding a real gap. `CompileError` and `Ignored` variants are excluded
   from the score's denominator precisely so suppression cannot be used to raise the score.
7. **Three gotcha notes (T038)**, each preventing a correct behaviour being filed as a bug:
   - `schedule` triggers run on the repository's **default branch only** — verified on
     2026-09-21 as `develop` via `gh repo view --json defaultBranchRef` and
     `git ls-remote --symref origin HEAD`. The absence of nightly runs on a feature branch is the
     platform, not a defect.
   - A renamed or deleted defended file produces a **full re-evaluation**, not a resurrected
     prior result, because Stryker keys incremental entries by path and content hash.
   - `.stryker-incremental.json` is **rewritten by every local run** and so appears in unrelated
     diffs. Commit it deliberately rather than reflexively.
8. **If Task 6 narrowed scope**, name the dropped directories and the reason here. Omit this
   section entirely if scope was not narrowed.

Match the prose register of `docs/kafka-acls.md` and `docs/ASSUMPTIONS.md`: explanatory
paragraphs, `##` headings, no bullet-only skeleton.

#### Constraints

- Quote the baseline from `baseline.md`. Do not restate a number from memory or from any other
  document.
- Do not invent a wall-clock figure; use Task 6's measurement.

#### Edge Cases

- If `specs/003-mutation-testing/baseline.md` is missing or holds an unfilled `<…>` placeholder,
  Task 5 did not complete — stop and report rather than writing a plausible number.

#### Verification

```bash
test -f docs/testing-mutation.md && wc -l docs/testing-mutation.md
grep -c 'Stryker disable' docs/testing-mutation.md
grep -ci 'default branch' docs/testing-mutation.md
grep -ci 'content hash' docs/testing-mutation.md
grep -ci 'stryker-incremental' docs/testing-mutation.md
```

Expected: the file exists and each grep returns at least 1.

#### Completion Criteria

- [ ] All five FR-020 topics covered.
- [ ] The baseline score and the floor arithmetic quoted from `baseline.md`.
- [ ] The suppression-justification rule stated explicitly.
- [ ] All three gotcha notes present.

---

### Task 12: Add the four required entries to `docs/ASSUMPTIONS.md`

Discharges T040.

#### Objective

Constitution Principle VII satisfied. This file's currency is a merge blocker (Workflow item 5),
so omitting these entries blocks merge.

#### Files

- `docs/ASSUMPTIONS.md` — MODIFIED: four sections appended.

#### Implementation

The file is a sequence of `## ` headed **prose** sections — explanatory paragraphs, not bullet
lists. Match that. Append four new sections at the end, each naming its rationale:

1. **The mutation floor is a measured number, not a target.** The baseline measured on the date
   in `specs/003-mutation-testing/baseline.md`, and the floor derived from it as
   `floor(score / 5) x 5`. State both numbers. Explain that `low` and `high` are colouring and
   aspiration only and do not affect exit status.

2. **`coverageAnalysis: 'perTest'` plus the TypeScript checker is a budget trade-off.** `perTest`
   narrows each variant's test set; the type checker discards variants that cannot compile before
   any test runs. Together they buy the 10-minute budget at the cost of a slower first run and a
   dependency on the coverage data being correct.

3. **The mutation check is a separate workflow file, and a second job in `ci.yml` cannot replace
   it.** GitHub Actions path filters are workflow-level (`on.pull_request.paths`); there is no
   job-level `paths` key. A path-filtered job inside `ci.yml` would suppress the existing `gate`
   job on pull requests touching no defended path.

4. **The retained prior-run state was relocated from the requested path.** The feature request
   named `.stryker-tmp/incremental.json`. `.stryker-tmp/` is Stryker's own sandbox — scratch
   space created and torn down around a run — so a file committed inside it is not durable. It is
   written to `.stryker-incremental.json` at the repository root instead, which also keeps the
   git-ignore rules disjoint and avoids a negation rule. The behaviour requested is unchanged;
   only the path differs.

**Do not add a fifth entry about a deferred README link.** That deferral was resolved when
`README.md` came into existence in PR #12 (research R-007); recording a deferral that no longer
applies misleads the next reader.

#### Constraints

- Append; do not reorder, reword or delete any existing section.
- Prose paragraphs under `## ` headings — match the file's established form.

#### Edge Cases

- If an entry on any of these four topics already exists, update it in place rather than adding a
  duplicate.

#### Verification

```bash
grep -c '^## ' docs/ASSUMPTIONS.md
tail -60 docs/ASSUMPTIONS.md
grep -ci 'stryker-incremental' docs/ASSUMPTIONS.md
grep -ci 'perTest' docs/ASSUMPTIONS.md
```

Expected: the heading count grew by exactly 4; all four topics are present in the tail.

#### Completion Criteria

- [ ] Exactly four new `## ` sections appended.
- [ ] Each states its rationale in prose.
- [ ] The baseline and derived floor are stated with real numbers.
- [ ] No fifth entry about a deferred README link.
- [ ] No existing section modified.

---

### Task 13: Link the documentation from `README.md`

Discharges T041.

#### Objective

FR-021 satisfied unconditionally, matching the README's existing conventions, with the
documentation drift gate still passing.

#### Files

- `README.md` — MODIFIED: two lines added.

#### Implementation

`README.md` exists (created by feature 002 in PR #12). Its `## Testing` section currently lists
five commands in one-line form:

```
- `npm run test:unit` — unit suite, no Docker.
- `npm test` — full suite including integration, needs a Docker daemon.
- `npm run test:cov` — coverage, enforces the 80% global threshold.
- `npm run test:recovery` — ledger recovery suite.
- `npm run test:perf` — performance suite.
- `npm run docs:verify` — the documentation gate.
```

Its `## Further reading` section links Constitution, Assumptions, Kafka ACLs, Plans,
Specifications.

1. Append to the `## Testing` list, in the same one-line form:

   ```
   - `npm run test:mutation` — mutation suite, no Docker.
   ```

2. Append to the `## Further reading` list:

   ```
   - [Mutation testing](docs/testing-mutation.md)
   ```

3. Verify the documentation drift gate still passes — the README is within its remit:

   ```bash
   npm run docs:verify
   ```

#### Constraints

- Do NOT invent a new README section; use the two that exist.
- Do NOT reword any existing README line.
- An earlier revision of this task was conditional on `README.md` existing and forbade creating a
  stub. That condition is settled — 002 merged, the file exists (research R-007). Apply it
  unconditionally.

#### Edge Cases

- If `npm run docs:verify` fails after the edit, the drift gate caught something — read its
  output and fix the README, do not weaken `scripts/verify-docs.sh`.

#### Verification

```bash
grep -n 'test:mutation' README.md
grep -n 'testing-mutation.md' README.md
npm run docs:verify; echo "exit=$?"
git diff --stat README.md
```

Expected:

- Both greps find exactly one line each.
- `docs:verify` prints `verify-docs: PASS` and exits `0`.
- The README diff shows exactly two added lines, nothing removed.

#### Completion Criteria

- [ ] One line added to `## Testing`, matching the existing one-line form.
- [ ] One line added to `## Further reading`.
- [ ] `npm run docs:verify` passes.
- [ ] No existing README line modified.

---

### Task 14: Run the quickstart end to end

Discharges T042.

#### Objective

Every stated expectation in the feature's own validation guide is confirmed against the finished
implementation.

#### Files

None modified. This task validates.

#### Implementation

Run `specs/003-mutation-testing/quickstart.md` Scenarios 1 through 6 plus the repository hygiene
check, confirming each stated expectation.

Scenarios 2 and 3 were already discharged by Tasks 5 and 7 and are not re-derived; confirm their
recorded results still hold against `specs/003-mutation-testing/baseline.md` and the configured
`thresholds.break`.

Scenario 4's red step was discharged by Task 8 and MUST NOT be repeated in the working tree.

#### Constraints

- Do not modify any test or source file to make a scenario pass.
- Do not re-run the red step outside a scratch worktree.

#### Edge Cases

- If a scenario's stated expectation contradicts the implemented behaviour, report which one and
  stop. Do not silently amend quickstart.md to match what was built.

#### Verification

See **Final Verification** below.

#### Completion Criteria

- [ ] Scenarios 1, 5 and 6 confirmed by execution.
- [ ] Scenarios 2 and 3 confirmed against the recorded baseline and configured threshold.
- [ ] Scenario 4 confirmed from Task 8's record, not repeated.
- [ ] The repository hygiene check passes.

---

## Final Verification

Run from the repository root on a clean checkout:

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run test:cov
npm run build
npm run docs:verify
npm run test:mutation
git diff -- .github/workflows/ci.yml .github/workflows/release-gates.yml
git status --porcelain
git worktree list
```

Expected:

- The seven pre-existing commands behave exactly as they did before this feature, including the
  80% global coverage threshold and the documentation drift gate (FR-025, SC-008).
- `npm run test:mutation` exits `0`, at or above the configured floor.
- Both workflow diffs are **empty** (FR-015).
- `git status --porcelain` shows no modification under `src/` or `test/` (FR-023, FR-024, SC-005).
- `git worktree list` shows only the main worktree — no leftover scratch copy.

---

## Executor Rules

1. Execute each task in a **separate sub-agent** with a fresh context; do not run multiple tasks
   inside one long-lived session.
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
13. If implementation reveals information that does not affect the prescribed solution, continue
    execution.
14. Stop rather than improvise when the plan cannot be executed as written.

### Feature-specific absolutes

15. **Never modify, weaken, skip or delete any existing test** (FR-023) — except inside Task 8's
    scratch worktree, which is destroyed before that task completes and is never committed.
16. **Never modify any file under `src/`** (FR-024).
17. **Never edit `.github/workflows/ci.yml` or `.github/workflows/release-gates.yml`.** Their
    diffs being empty is asserted evidence, not a preference.
18. **Never invent a mutation score or a threshold.** Every number comes from
    `specs/003-mutation-testing/baseline.md`, which Task 5 writes from a real run. If that file
    is missing or holds an unfilled `<…>` placeholder, Task 5 did not complete — stop.
19. **Tasks 5 → 7 → 9 are strictly sequential and cannot be parallelised.** The floor derives from
    the baseline; the automation asserts on the floor. This is the deliberate exception to the
    usual story-independence rule.

The executor may stop only for a concrete blocker such as:

- a referenced file, API, dependency, or subsystem does not exist;
- repository state materially contradicts facts the plan depends on;
- a required credential or external resource is unavailable;
- the prescribed implementation is technically impossible;
- executing the plan would require making an architectural or product decision not covered by
  the plan;
- two instructions in the plan directly contradict each other;
- verification proves that an assumption fundamental to the planned implementation is false.

When stopping, the executor must report: the task number; the exact blocker; the evidence
establishing the blocker; which plan assumption is invalid; and the minimum planning decision
required to continue.

The executor must **not** propose or implement an alternative unless explicitly asked to re-plan.
