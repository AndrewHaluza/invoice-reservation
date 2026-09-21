# Contract: The Mutation Command

**Feature**: 003-mutation-testing | **Date**: 2026-09-21

The interface this feature exposes to developers and to automation. Every assertion below
is verifiable from outside the implementation.

---

## C-1. Invocation

```bash
npm run test:mutation
```

- **C-1.1** — `package.json` `scripts` MUST define exactly one key, `test:mutation`, that
  performs a full mutation run. (FR-019)
- **C-1.2** — The command MUST require no argument, no environment variable, and no
  running container runtime. (FR-003, SC-001, SC-003)
- **C-1.3** — The command MUST be runnable immediately after `npm ci` on a clean
  checkout. (SC-001)
- **C-1.4** — Adding it MUST NOT alter the behaviour of `test`, `test:unit`, `test:cov`,
  `test:recovery`, `test:perf`, `typecheck`, `lint` or `build`. (FR-025, SC-008)

## C-2. Exit status

- **C-2.1** — Exit `0` when the effectiveness score is greater than or equal to
  `thresholds.break`. (FR-011)
- **C-2.2** — Exit **non-zero** when the score is below `thresholds.break`, and the output
  MUST state both the achieved score and the floor it missed. (FR-011, SC-004)
- **C-2.3** — Exit non-zero when the unit suite is already failing before mutation begins,
  reporting the broken suite rather than a score. (Edge case: already-red suite)
- **C-2.4** — `thresholds.low` and `thresholds.high` MUST NOT influence the exit status.
  (FR-010)
- **C-2.5** — All three thresholds MUST be derived mechanically from the measured
  baseline, leaving no choice to the implementer:
  - `break` = baseline rounded **down** to the nearest multiple of 5 (FR-009).
  - `low` = `break + 5`.
  - `high` = `break + 10`.
  If `break + 10` exceeds 100, `high` is 100 and `low` is 95. These two are colouring and
  aspiration only; C-2.4 governs their effect on exit status, which is none.

## C-3. Output on completion

- **C-3.1** — The terminal summary MUST report the effectiveness score. (FR-004)
- **C-3.2** — It MUST report four separate counts: detected, undetected, timed out, and
  never executed. (FR-004)
- **C-3.3** — It MUST report timed-out variants as their own count, distinct from the
  score, so machine-speed effects remain visible. (Edge case: determinism)
- **C-3.4** — Progress MUST be emitted while the run is in flight, so a slow run is
  distinguishable from a stuck one. (FR-006)

## C-4. The report artefact

- **C-4.1** — A browsable HTML report MUST be written to `reports/mutation/mutation.html`.
  (FR-005)
- **C-4.2** — Every **undetected** variant in it MUST be traceable to its source file,
  line number, original code and altered code. (FR-005, SC-006)
- **C-4.3** — `reports/` MUST be git-ignored. (FR-007)

## C-5. Scope guarantees

- **C-5.1** — Only files matching the six FR-001 patterns are mutated. A variant reported
  outside them is a contract breach. (FR-001)
- **C-5.2** — The FR-002 exclusions MUST be configured even though they currently remove
  zero files from the defended directories. (FR-002, R-009)
- **C-5.3** — Only tests under `test/unit` are executed. Any execution of
  `test/integration`, `test/migration`, `test/contract` or `test/performance` during a
  mutation run is a contract breach. (FR-003)
- **C-5.4** — The exclusion MUST be structural, via `roots` in `jest.mutation.config.js`,
  not a subtractive ignore pattern. (R-002)

## C-6. Non-interference

- **C-6.1** — After a run, every file tracked by git MUST be unchanged except
  `.stryker-incremental.json`. (FR-024, SC-005)
- **C-6.2** — No test file is modified, weakened, skipped or deleted at any point in this
  feature. (FR-023)
- **C-6.3** — No production source file is modified. (FR-024)
- **C-6.4** — `npm run lint` and `npm run typecheck` MUST report the same result on every
  pre-existing file as they did before this feature. (FR-025, FR-026)

## C-7. Suppression

- **C-7.1** — An individual variant may be suppressed only by an inline comment carrying a
  written justification of why it is undetectable rather than untested. (FR-022)
- **C-7.2** — A suppression without a justification is non-conforming and MUST be treated
  as a review-blocking defect. (FR-022)
- **C-7.3** — Suppressed variants are excluded from the score denominator, so suppression
  MUST NOT be used to raise the score. (Data model §4)

## C-8. Time budget

- **C-8.1** — A full run completes in under 10 minutes on the CI runner. (FR-012, SC-002)
- **C-8.2** — If C-8.1 cannot be met over the full scope, the scope is narrowed and the
  omitted directories and the reason are recorded in `docs/testing-mutation.md` and
  `docs/ASSUMPTIONS.md`. Silently exceeding the budget is non-conforming. (FR-013)

---

## Verification matrix

| Assertion | How verified |
|---|---|
| C-1.1..C-1.3 | Fresh clone, `npm ci`, `npm run test:mutation` |
| C-1.4, C-6.4 | Run each pre-existing script before and after; compare output |
| C-2.1 | Run on unmodified repo; `echo $?` is `0` |
| C-2.2 | Scratch copy with an assertion deleted; `echo $?` is non-zero |
| C-2.3 | Scratch copy with a deliberately broken unit test |
| C-3.1..C-3.4 | Read the terminal output of any run |
| C-4.1, C-4.2 | Open the HTML report; pick any undetected variant |
| C-5.1, C-5.3 | Inspect the report's file list; confirm no path outside scope |
| C-6.1 | `git status --porcelain` after a run |
| C-8.1 | Wall time of the CI job |
