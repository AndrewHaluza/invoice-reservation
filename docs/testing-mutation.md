# Mutation testing for the defended business logic

`npm run test:mutation` runs [StrykerJS](https://stryker-mutator.io/) over the six
directories that carry the money and ledger logic — `src/capacity/domain/**`,
`src/capacity/application/**`, `src/shared/money/**`, `src/shared/result/**`,
`src/treasury/handlers/**` and `src/treasury/retry/**` — and measures how many of the
deliberate alterations it introduces the unit suite actually detects. It exists because a
green suite says tests passed, not that they would fail if the logic changed underneath
them. A mutated line that no test notices is a hole in the suite's coverage of behaviour,
and this command is how that hole becomes visible.

The command is described by [`specs/003-mutation-testing/`](../specs/003-mutation-testing/spec.md)
and enforced by the arithmetic in
[`specs/003-mutation-testing/baseline.md`](../specs/003-mutation-testing/baseline.md).

## Running it locally

From the repository root:

```
npm run test:mutation
```

It needs no Docker daemon and no running services. Stryker copies the source into its own
sandbox, rewrites it there one alteration at a time, and runs the container-free unit suite
against each altered copy. The initial run over the full scope took **3m 27s** on a local
workstation, well inside the ten-minute budget the automation holds it to. A later run
reuses the prior results recorded in `.stryker-incremental.json` and is typically much
faster, so do not read a short run as a run that did less work.

The command writes a browsable report to `reports/mutation/mutation.html`. That path and
Stryker's scratch directory `.stryker-tmp/` are both git-ignored; only
`.stryker-incremental.json` is tracked, and it is rewritten by every run.

## Reading an undetected change

Open `reports/mutation/mutation.html` and filter to **Survived**. Each surviving entry
shows the source file and line number, the original code, and the altered code Stryker
substituted. The clear-text summary printed to the terminal carries the same information
for a handful of survivors, but the report is the complete list and is what to open when
the score dips.

A survivor is a place where the altered code produces different behaviour from the
original and no test failed. It is a question, not automatically a defect: sometimes the
altered code is genuinely equivalent, and sometimes the behaviour is real but untested.

## Deciding what to do about one

The rule is narrow. **Add or strengthen a test when the altered code produces genuinely
different behaviour that no assertion checks.** That is the normal case and the reason the
feature exists — a survivor under the money conversion maths or the release policy is
almost always a missing assertion.

**Suppress the variant only when the altered code is provably equivalent to the original**
— when the change cannot alter behaviour for any input. An equivalent mutant is noise, and
suppressing it is the honest response; suppressing a real gap is not.

## Why the floor sits where it does

The enforcement floor is not a target chosen in advance. It is derived arithmetically from
one real measurement. The baseline in `baseline.md` recorded a mutation score of **37.7%**
over the defended scope, and the floor is that score rounded down to the nearest multiple
of five:

- `break` = largest multiple of 5 not exceeding 37.7 = **35**
- `low` = `break` + 5 = **40**
- `high` = `break` + 10 = **45**

Only `break` governs the command's exit status. A run at or above 35 exits zero; a run
below it exits non-zero and prints both the achieved score and the floor it missed. `low`
and `high` only colour the report and state an aspiration, so a run can exit zero while
still reporting against them. The measured score is deliberately not the suite's true
effectiveness — see the exclusion below — so the floor is a fence around today's number,
not a claim about the ceiling.

## Suppressing a change

Every suppression — a `// Stryker disable` comment — **must carry an inline written
justification, on the same line or immediately above it.** A bare `// Stryker disable` is
forbidden and is a review-blocking defect: without a stated reason it is indistinguishable
from hiding a real gap. Suppression cannot be used to raise the score either: variants
that fail to compile (`CompileError`) and variants explicitly ignored are both excluded
from the score's denominator, so disabling a variant removes it from the measure rather
than marking it detected.

## The source-scanning spec is excluded from the mutation run

`test/unit/no-auto-expiry.spec.ts` is not run during a mutation run. That spec reads every
file under `src/` as raw text and asserts over its lines; Stryker's instrumenter reprints
source files into its sandbox, which collapses two constants in
`src/capacity/domain/errors.ts` onto a single line and trips the assertion. The test is
correct, the source is correct and Stryker is correct — a test that asserts over source
text cannot compose with a tool whose method is rewriting source text. The exclusion is
expressed through `testPathIgnorePatterns` in `jest.mutation.config.js` and applies to the
mutation run only: `npm run test:unit`, `npm test` and `npm run test:cov` all still run
that spec. The recorded baseline understates what the suite actually detects, because that
spec also holds behavioural assertions over `releasePolicy`, `cancelPolicy` and
`scaleRate`; the floor is correspondingly slack rather than tight.

## Three behaviours that look like defects but are not

**The nightly run only appears on the default branch.** The `schedule` trigger fires on the
repository's default branch — `develop`, as of 2026-09-21 — and never on a feature branch.
The absence of a nightly mutation run on a branch under development is the platform, not a
missing job. To watch the check run, open a pull request that touches one of the six
defended directories, or the mutation configuration.

**A renamed or deleted defended file is re-evaluated in full.** Stryker keys its retained
results by file path and content hash, so moving a file changes its key and its prior
result is not resurrected. A renamed file costs a full re-evaluation of that file rather
than reusing a stale verdict.

**`.stryker-incremental.json` is rewritten by every local run.** It therefore shows up as a
modified file in unrelated diffs. Commit it deliberately rather than reflexively; it is
tracked so a fresh checkout can reuse prior results, and it is not a source of truth about
anything except which variants have already been evaluated.
