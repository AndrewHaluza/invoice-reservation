# Amendment 1 to the Mutation Testing Gate execution plan

**Applies to**: `docs/plans/2026-09-21-mutation-testing-gate.md`
**Ticket**: FEAT-12-MUTATION-TESTING-GATE | **Date**: 2026-09-21

This amendment resolves the blocker reported during Task 5. It is **binding** and overrides
the base plan wherever the two differ.

Read this file completely before running any command.

---

## 0. State of the work — already done, do not repeat

Tasks 1, 2, 3 and 4 are **complete and committed**. The rebase onto corrected artifacts is
**already done for you**. Your branch is:

```
karst/feat/feat-12-mutation-testing-gate-measure-business-logic-test-ef
```

with this history (newest first):

```
430b213 build(mutation): add stryker.config.mjs scope, runner and reporters
43fc493 test(mutation): add container-free Jest config restricted to test/unit
033f496 chore(mutation): ignore mutation reports and tmp, list new configs in eslint ignores
bac0c9a chore(mutation): add pinned StrykerJS devDependencies and test:mutation script
7766e1f docs: correct stale measurements and record the instrumentation conflict
```

**Do NOT run `git rebase`. Do NOT run `git merge`. Do NOT run `git pull`.** They are done.

Your working directory for every command in this document is exactly:

```
/Users/nd/Work/projects/invoice-reservation/.karst/worktrees/feat-12-mutation-testing-gate-measure-business-logic-test-ef
```

Never `cd` out of it. Never run a command in `/Users/nd/Work/projects/invoice-reservation`.

---

## 1. Verify your starting state

Run these four commands. Every one must print what is shown.

```bash
cd /Users/nd/Work/projects/invoice-reservation/.karst/worktrees/feat-12-mutation-testing-gate-measure-business-logic-test-ef
git status --porcelain
```
Expected: **no output at all.**
If there is any output → STOP. Report "working tree not clean at Amendment step 1".

```bash
git log --oneline -1
```
Expected exactly: `430b213 build(mutation): add stryker.config.mjs scope, runner and reporters`
If different → STOP. Report "unexpected HEAD at Amendment step 1", and paste what you got.

```bash
grep -c '^## R-010' specs/003-mutation-testing/research.md
```
Expected exactly: `1`
If `0` → STOP. Report "R-010 missing at Amendment step 1".

```bash
ls jest.mutation.config.js stryker.config.mjs
```
Expected: both filenames printed, no error.
If either is missing → STOP. Report "config file missing at Amendment step 1".

---

## 2. The ruling, stated once

`test/unit/no-auto-expiry.spec.ts` reads every file under `src/` as raw text and asserts no
line contains both a reservation word and an expiry word. Stryker rewrites source into a
sandbox, which collapses two constants in `src/capacity/domain/errors.ts` onto one line. The
meta-test reads the sandbox copy and fails. Nothing is broken; a source-scanning test cannot
compose with a source-rewriting tool.

**Resolution: exclude that one spec from the mutation run only.**

You do not need to evaluate alternatives. They were evaluated and rejected. Excluding
`errors.ts` from `mutate` breaks FR-001. Editing the meta-test breaks FR-023. Both are
forbidden. Do not do either.

---

## 3. Step A — edit `jest.mutation.config.js`

Overwrite `jest.mutation.config.js` so that its **entire** contents are exactly this:

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
 * `testPathIgnorePatterns` excludes exactly one spec. test/unit/no-auto-expiry.spec.ts
 * reads every file under src/ as raw text and asserts over its lines; Stryker's
 * instrumenter reprints those files in its sandbox, collapsing two constants in
 * src/capacity/domain/errors.ts onto a single line and tripping the assertion. The test
 * is correct, the source is correct, and Stryker is correct — a test that asserts over
 * source text cannot compose with a tool whose method is rewriting source text. This
 * exclusion applies to the mutation run ONLY: npm run test:unit, npm test and
 * npm run test:cov continue to run that spec unchanged. See research R-010.
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
  testPathIgnorePatterns: ['/node_modules/', 'test/unit/no-auto-expiry\\.spec\\.ts$'],
  moduleFileExtensions: ['js', 'json', 'ts'],
};
```

Change no other file. Do not touch `jest.config.ts`. Do not touch `stryker.config.mjs`. Do
not touch anything under `src/` or `test/`.

### Verify Step A

```bash
npx jest --config jest.mutation.config.js --listTests | grep -c 'no-auto-expiry'
```
Expected exactly: `0`
If `1` → the edit did not take. Re-apply Step A.

```bash
npx jest --config jest.mutation.config.js --listTests | wc -l
```
Expected exactly: `34`
If `35` → the edit did not take. If anything else → STOP and report the number.

```bash
npx jest --config jest.mutation.config.js --listTests | grep -cE 'test/(integration|migration|contract|performance)/'
```
Expected exactly: `0`
If not `0` → STOP. Report "container suites leaked at Amendment step A".

```bash
npm run test:unit 2>&1 | tail -4
```
Expected to contain: `Test Suites: 35 passed, 35 total` and `Tests:       324 passed, 324 total`
The count must stay **35**, not 34. If it says 34 → you edited the wrong config file. Revert
and re-apply Step A to `jest.mutation.config.js` only.

### Commit Step A

```bash
git add jest.mutation.config.js
git commit -F - <<'MSG'
build(mutation): exclude the source-scanning meta-test from the mutation run

test/unit/no-auto-expiry.spec.ts reads every file under src/ as raw text and
asserts over its lines. Stryker's instrumenter reprints those files in its
sandbox, collapsing IDEMPOTENCY_EXPIRED and RESERVATION_TERMINAL in
src/capacity/domain/errors.ts onto a single line, which trips the assertion.
The test is correct, the source is correct and Stryker is correct - a test
asserting over source text cannot compose with a tool whose method is
rewriting source text. See research R-010.

Excluded through testPathIgnorePatterns in jest.mutation.config.js only.
npm run test:unit, npm test and npm run test:cov continue to run that spec
unchanged, still 35 suites and 324 tests.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SVatmp4H6RRW7YLdypnq2H
MSG
```

---

## 4. Step B — Task 5, the baseline

### B1. Precondition

```bash
npm run test:unit 2>&1 | tail -4
```

Must show `35 passed` suites and `324 passed` tests.
If any test fails → STOP. Report "unit suite red before baseline" and paste the failure. Do
**not** fix the test. FR-023 forbids modifying any test.

### B2. Run the baseline

```bash
time npm run test:mutation 2>&1 | tee /tmp/stryker-baseline.log
```

Do not edit any file while this runs. It may take several minutes.

**Stop conditions — if any of these appear, STOP and report, do not improvise:**

| What you see | Report this |
|---|---|
| `ConfigError: There were failed tests in the initial test run` | "dry run still failing after Amendment step A" + the failing spec name |
| Any line mentioning `testcontainers`, `Postgres`, `Redis`, `Redpanda` | "container leakage in mutation run" |
| An error naming `composite`, `project references` or `build mode` | "typescript-checker rejects tsconfig" |
| The run exceeds 20 minutes wall clock | "baseline run over 20 minutes" + the elapsed time |

If none of those appear, the run completes and prints a summary table. Continue.

### B3. Read six numbers off the summary

From the `clear-text` summary Stryker printed, copy these **verbatim**. Do not round. Do not
calculate. Do not take a number from any other document.

- the mutation score, as a percentage to one decimal place
- `Killed` count
- `Survived` count
- `Timeout` count
- `NoCoverage` count
- `CompileError` count
- `Ignored` count
- the total number of mutants

### B4. Compute the three thresholds

Use this arithmetic and nothing else. `S` is the score from B3.

1. `break` = the largest multiple of 5 that is less than or equal to `S`.
   Worked example: if `S` is 73.4, `break` is 70. If `S` is 75.0, `break` is 75.
2. `low` = `break + 5`
3. `high` = `break + 10`
4. **Then**, if `high` is greater than 100: set `high` to 100 and set `low` to 95.

Do not pick a number. Do not use 100 unless rule 4 produced it.

### B5. Write `specs/003-mutation-testing/baseline.md`

Create that file with exactly this content, replacing every `<...>` with a value from B3 or
B4. Leave every other character as written, including the Limitation paragraph.

```markdown
# Measured Baseline: Mutation Testing

**Feature**: 003-mutation-testing | **Measured**: 2026-09-21

This file is the single authoritative record of the FR-008 baseline. Every threshold, every
documentation figure and every assumption entry in this feature derives from the numbers
below. They were produced by one real run, not estimated. Nothing in this feature predicted
them, and nothing should.

## The run

- Command: `npm run test:mutation`
- Stryker: 10.0.0
- Configuration: `stryker.config.mjs` with **no `thresholds` block**
- Scope: 32 files / 3400 lines across the six FR-001 directories
- Tests executed: 34 of the 35 unit suites. `test/unit/no-auto-expiry.spec.ts` is excluded
  from the mutation run only (research R-010); it still runs in `npm run test:unit`,
  `npm test` and `npm run test:cov`.
- Wall-clock time: <Xm Ys>
- Machine: local workstation

## Result

| Metric | Value |
|---|---|
| Mutation score | <S>% |
| Killed (detected) | <N> |
| Survived (undetected) | <N> |
| Timeout (timed out) | <N> |
| NoCoverage (never executed) | <N> |
| CompileError | <N> |
| Ignored | <N> |
| Total variants | <N> |

**Limitation.** `test/unit/no-auto-expiry.spec.ts` is excluded from the mutation run
(research R-010). That spec also holds behavioural assertions over `releasePolicy`,
`cancelPolicy` and `scaleRate`, so this score understates what the suite actually detects,
and the floor derived from it is correspondingly slack. It is not the suite's true
effectiveness.

## Derived floor

Arithmetic per contract C-2.5, applied to the score above:

- `break` = largest multiple of 5 not exceeding <S> = **<break>**
- `low`  = break + 5  = **<low>**
- `high` = break + 10 = **<high>**

If `break + 10` exceeds 100, `high` is 100 and `low` is 95.

Only `break` governs exit status (FR-010, contract C-2.4).
```

### B6. Verify Step B

```bash
test -f specs/003-mutation-testing/baseline.md && echo FILE_OK
grep -c '<' specs/003-mutation-testing/baseline.md
```
Expected: `FILE_OK`, then `0`.
A non-zero second number means you left a `<...>` placeholder unfilled. Fill it.

```bash
grep -c 'Limitation' specs/003-mutation-testing/baseline.md
```
Expected exactly: `1`

```bash
git status --porcelain -- src test
```
Expected: **no output at all.**
If there is output → STOP. Report "source or test modified during baseline".

### Commit Step B

```bash
git add specs/003-mutation-testing/baseline.md .stryker-incremental.json
git commit -F - <<'MSG'
test(mutation): record the measured baseline

One real mutation run over the six defended directories, with no thresholds
block configured, so the score rather than the exit status is the result.
Numbers recorded verbatim from that run; nothing in this feature predicted
them.

The run executed 34 of the 35 unit suites. test/unit/no-auto-expiry.spec.ts
is excluded from the mutation run only, per research R-010, and that spec
also holds behavioural assertions over releasePolicy, cancelPolicy and
scaleRate - so the recorded score understates what the suite actually
detects and the floor derived from it is correspondingly slack. baseline.md
states this next to the number rather than presenting the score as the
suite's true effectiveness.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SVatmp4H6RRW7YLdypnq2H
MSG
```

---

## 5. After Task 5

Return to `docs/plans/2026-09-21-mutation-testing-gate.md` and continue at **Task 6**,
following it exactly, with these three amendments applied wherever they touch it.

### Amendment to Task 6

Task 6 step 4 tells you to compare the wall-clock time against a 10-minute budget. Use the
figure you wrote into `baseline.md`. If it is under 10 minutes, change nothing and proceed.
If it is over, follow Task 6's tuning order exactly as written; do not invent a different
order and do not narrow scope before the first three steps have each been tried.

### Amendment to Task 11

`docs/testing-mutation.md` must contain a short section stating that
`test/unit/no-auto-expiry.spec.ts` is excluded from the mutation run, why (it asserts over
source text, which instrumentation rewrites), and that it still runs in `npm run test:unit`,
`npm test` and `npm run test:cov`. A reader who notices the spec is absent must find the
answer there without opening `research.md`.

### Amendment to Task 12

Task 12 says to add **four** entries to `docs/ASSUMPTIONS.md`. Add **five**. The fifth is:

> **A source-scanning meta-test is excluded from the mutation run.**
> `test/unit/no-auto-expiry.spec.ts` asserts over the text of every file under `src/`.
> Stryker rewrites source into a sandbox, which collapses two constants in
> `src/capacity/domain/errors.ts` onto one line and trips that assertion. The test, the
> source and the tool are each correct; a test asserting over source text cannot compose
> with a tool whose method is rewriting source text. The spec is excluded from the mutation
> run only and still runs in every other suite. The cost is that the measured baseline
> understates the suite's true effectiveness, because that spec also holds behavioural
> assertions over `releasePolicy`, `cancelPolicy` and `scaleRate`; the floor is therefore
> slack rather than tight.

Task 12's instruction "do not add a fifth entry about a deferred README link" still stands
and refers to a **different** entry. That README entry stays dropped. This R-010 entry is an
addition, bringing the total to five.

---

## 6. Absolutes — these override anything that seems more convenient

1. Never modify any file under `src/`.
2. Never modify, weaken, skip or delete any file under `test/`. The only exception is inside
   Task 8's scratch worktree, which that task destroys before it completes.
3. Never edit `.github/workflows/ci.yml` or `.github/workflows/release-gates.yml`.
4. Never invent a mutation score or a threshold. Every number comes from `baseline.md`.
5. Never widen the `testPathIgnorePatterns` exclusion beyond the single spec named here. A
   second spec failing under instrumentation is a new decision — STOP and report it.
6. Never change the `mutate` globs in `stryker.config.mjs`.
7. Never run `git rebase`, `git merge` or `git pull` in this worktree.
8. Never `cd` outside this worktree.
9. When a STOP condition in this document is met, stop and report. Do not try an alternative.

When you stop, report: the step number in this document, the exact command you ran, its exact
output, and which expectation it failed.
