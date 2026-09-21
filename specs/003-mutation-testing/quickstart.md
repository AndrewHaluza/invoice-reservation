# Quickstart: Validating Mutation Testing

**Feature**: 003-mutation-testing | **Date**: 2026-09-21

Six scenarios that together prove the feature works end to end. Run them in order —
scenario 2 produces the number scenario 3 configures.

**Prerequisites**: Node 22.x, `npm ci` completed. **No Docker daemon is required** — that
is itself part of what scenario 1 proves.

---

## Scenario 1 — The run works, and needs no containers

```bash
npm run test:unit          # precondition: must be green before mutating anything
npm run test:mutation
```

**Expected**:
- `test:unit` reports **35 passed suites, 324 tests** in roughly 7 seconds.
- The mutation run emits live progress, then a summary carrying the score and four
  separate counts: detected, undetected, timed out, never executed.
- It completes on a machine with the Docker daemon stopped.
- No log line mentions testcontainers, Postgres, Redis or Redpanda. If one does,
  contract C-5.3 is broken — the wrong Jest config is in play.

Covers: US1 scenarios 1 and 3, FR-003, FR-004, FR-006, SC-001, SC-003.

---

## Scenario 2 — Record the baseline

Run with **no** `thresholds.break` configured (or `break: 0`), so the run cannot fail on
score.

```bash
npm run test:mutation
```

**Expected**: a concrete percentage, plus the four counts and the total variant population.

**Then**: write the score verbatim into `docs/testing-mutation.md` and
`docs/ASSUMPTIONS.md`.

> Before the run, this number is **unknown**. No artefact in this feature predicted a
> score, and none should have. The scope is 32 files / 3400 lines; only the run is
> authoritative.

**Measured** on 2026-09-21, Stryker 10.0.0, local workstation, wall-clock 3m 27s,
with no `thresholds` block configured. Recorded verbatim, not rounded:

| Metric | Value |
|---|---|
| Mutation score | 37.7% |
| Killed (detected) | 308 |
| Survived (undetected) | 94 |
| Timeout (timed out) | 9 |
| NoCoverage (never executed) | 429 |
| CompileError | 690 |
| Ignored | 0 |
| Total variants | 1530 |

34 of the 35 unit suites executed; `test/unit/no-auto-expiry.spec.ts` is excluded from the
mutation run only (research R-010), so this score understates the suite's true
effectiveness. `specs/003-mutation-testing/baseline.md` is the authoritative record and
carries the full derivation; the figures above must agree with it.

Covers: FR-004, FR-008, US1 scenario 1.

---

## Scenario 3 — Derive and install the floor

Compute `floor(baseline ÷ 5) × 5`. Write it to `thresholds.break`. Set
`thresholds.low` and `thresholds.high` above it as aspiration.

```bash
npm run test:mutation
echo $?
```

**Expected**: `0`. The score is by construction at or above a floor derived from it.

**Check**: the configured `break` equals the documented baseline rounded down to the
nearest five, and `break < low <= high <= 100`.

Covers: FR-009, FR-010, FR-011, US2 scenarios 1 and 3, SC-009.

---

## Scenario 4 — Prove the gate can actually fail

The one scenario that must not be skipped. A gate never observed failing is not a gate.

```bash
git status --porcelain            # expect clean apart from .stryker-incremental.json
# in a scratch copy only — never on the working branch:
#   delete assertions from one unit test covering the defended scope
npm run test:mutation
echo $?
```

**Expected**: non-zero, with output naming the achieved score and the floor it missed.

**Then**: discard the scratch copy entirely. `git status --porcelain` must return to clean.

> The weakened test is **never committed**. FR-023 forbids modifying any existing test, and
> this scenario is a throwaway probe, not a change.

Covers: FR-011, FR-023, US2 scenario 2, SC-004, and the Constitution Principle VI red step
recorded in plan.md.

---

## Scenario 5 — Read a surviving variant

Open `reports/mutation/mutation.html`, filter to **Survived**, pick any entry.

**Expected**: source file, line number, original code and altered code are all visible, and
the file path lies inside the six defended directories — never outside.

Then apply the decision rule from `docs/testing-mutation.md`:
- The altered code produces genuinely different behaviour that no assertion checks → **add
  a test**.
- The altered code is provably equivalent to the original → **suppress it with an inline
  written justification** (FR-022). A bare suppression is a review-blocking defect.

Covers: FR-005, FR-020, FR-022, US1 scenario 2, SC-006, SC-011.

---

## Scenario 6 — The automation behaves, and disturbs nothing

1. Open a pull request touching a file under `src/shared/money/**` → the mutation job
   **runs**.
2. Open a pull request touching only `docs/**` → the mutation job **does not run**.
3. Confirm `git diff` on `.github/workflows/ci.yml` is **empty**.
4. Force a mutation failure → the existing `gate` job still reports lint, typecheck, test,
   coverage and build exactly as before.
5. Download the HTML report from a completed run — from a **failing** one as well as a
   passing one.
6. Confirm a scheduled run appears on the default branch.

**Expected**: all six hold.

> Nightly runs appear on the **default branch only** — GitHub runs `schedule` triggers
> nowhere else. Their absence on a feature branch is the platform, not a defect.

Covers: FR-014 through FR-018, US3 scenarios 1–5, SC-007, SC-008, SC-010.

---

## Repository hygiene check

After every scenario:

```bash
git status --porcelain
```

**Expected**: clean, except `.stryker-incremental.json`, which is the one generated file
deliberately committed (FR-007, FR-012). `reports/` and `.stryker-tmp/` must never appear —
if they do, the `.gitignore` entries are missing.

Covers: FR-007, FR-024, SC-005.
