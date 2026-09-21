# Phase 0 Research: Mutation Testing

**Feature**: 003-mutation-testing | **Date**: 2026-09-21

All findings below were established by reading this repository, not assumed. Every
Technical Context entry is resolved; no NEEDS CLARIFICATION remains.

---

## R-001: Tool selection

**Decision**: StrykerJS — `@stryker-mutator/core`, `@stryker-mutator/jest-runner`,
`@stryker-mutator/typescript-checker`, all pinned to one matching minor.

**Rationale**: Named outright by the requester with "do not evaluate alternatives".
It is also the only mature mutation framework for TypeScript with a first-party Jest
runner and a type-checker plug-in.

**Alternatives considered**: none, per instruction.

**Open at plan time**: the exact published version. The three packages must share a
version; mixing a core with an older runner breaks the plug-in API. The installing task
resolves and pins the current matching set rather than using a floating range.

---

## R-002: Which Jest configuration the mutation run uses

**Decision**: a new, dedicated, plain-CommonJS `jest.mutation.config.js` at the repo
root, referenced from Stryker as `jest.configFile`.

**Rationale, from the repo**: the project's `jest.config.ts` is a **TypeScript** config
file whose `roots` are `['<rootDir>/src', '<rootDir>/test']` and whose `testRegex` is
`.*\.spec\.ts$`. Two consequences:

1. `npm run test:unit` is `jest test/unit` — the restriction to unit tests is a
   **positional path filter at the command line**, not a property of the config. Stryker
   does not invoke the npm script; it drives Jest programmatically. Pointing Stryker at
   the existing config would therefore run the **entire** suite, including
   `test/integration/**` and `test/migration/**`, which need a Docker daemon. This is the
   exact trap FR-003 names, and it is invisible until a mutant run hangs on
   testcontainers.
2. A `.ts` Jest config must be transpiled before Jest can read it. Whether Stryker's
   runner resolves a TypeScript config file reliably is version-dependent and is an
   avoidable risk.

A plain `.js` config eliminates both: it sets `roots: ['<rootDir>/test/unit']`, so the
container-dependent suites are structurally unreachable rather than merely unselected,
and it needs no transpilation step.

**Alternatives considered**:
- *Inline `jest.config` override inside the Stryker config* — rejected: it duplicates
  the ts-jest preset and drifts from `jest.config.ts` silently.
- *Reusing `jest.config.ts` plus a `testPathPattern`* — rejected: leaves the Docker-bound
  suites one configuration slip away from executing, and depends on TS-config resolution.

**Must-carry settings** in the new config: `preset: 'ts-jest'`, `testEnvironment: 'node'`,
`rootDir: '.'`, `roots: ['<rootDir>/test/unit']`, `testRegex: '.*\.spec\.ts$'`, and **no**
`coverageThreshold` — the existing 80% global gate belongs to `test:cov` and must not fire
inside a mutation run.

---

## R-003: Run-time budget — measured inputs, not guesses

**Measured in this repository on 2026-09-21**:

| Quantity | Value | How obtained |
|---|---|---|
| Unit suites | 29 | `jest test/unit` |
| Unit tests | 287 | same |
| Suite wall time | **5.99 s** | same |
| Full command wall time | **8.2 s** | `time npx jest test/unit` |
| Source files in scope | **32** | `find` over the six FR-001 directories |
| Source lines in scope | **3383** | `wc -l` over those files |

**Decision**: target the 10-minute budget with `coverageAnalysis: 'perTest'`,
`concurrency` left to Stryker's default (derived from available cores), a per-mutant
`timeoutMS` of 5000 with `timeoutFactor: 1.5`, and an incremental file.

**Rationale**: `perTest` is the whole budget argument. Without it every mutant re-runs all
287 tests (~6 s each); at even 800 mutants that is over an hour regardless of parallelism.
With `perTest`, Stryker records which tests touch which code during one initial run and
then executes only the covering tests per mutant. The typescript-checker compounds the
saving by discarding mutants that do not compile **before** any test runs — with
`strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` all on, a large
share of mutants in this codebase will not type-check.

3383 lines of dense domain logic implies roughly 900–1600 mutants. This is an estimate,
and the plan does not depend on it: FR-013 already defines what happens if the budget is
missed, and the baseline task measures the real number.

**Alternatives considered**:
- *`coverageAnalysis: 'all'`* — rejected: blows the budget by an order of magnitude.
- *`coverageAnalysis: 'off'`* — rejected: strictly worse than `all`.
- *Pinning `concurrency` to a fixed number* — rejected: the developer laptop and the
  2–4 vCPU GitHub runner want different values, and Stryker's default already derives one
  per machine. Pinning would optimise one at the other's expense.

---

## R-004: Where the incremental file lives

**Decision**: `.stryker-incremental.json` at the repository root, set via `incrementalFile`,
**committed** to version control. Generated reports go to `reports/` and the sandbox to
`.stryker-tmp/`, both **git-ignored**.

**Rationale**: FR-007 wants artefacts out of version control; FR-012 wants the prior-run
state retained so CI benefits from it. Stryker's default incremental path sits *inside*
`reports/`, which would force a git-ignore negation rule (`reports/` ignored, one file
inside it un-ignored) — a pattern that behaves differently across git versions and is easy
to break. Moving the incremental file to the repo root makes the two rules disjoint and
removes the negation entirely.

The repo's current `.gitignore` is six lines (`node_modules/`, `dist/`, `coverage/`,
`.env`, `*.log`, `.karst/worktrees/`) and has no negation rules today; introducing the
first one for this feature is not worth it.

**This deviates from the feature request, deliberately.** The request named
`.stryker-tmp/incremental.json`. That path is inside Stryker's **sandbox** directory —
scratch space the tool creates and tears down around a run — so a file committed there is
not durable and may be removed by the next run. The root placement preserves exactly the
behaviour the request asked for (retained prior-run state, committed to version control)
and changes only where it lives. Per Constitution Principle VII this deviation is a
required `docs/ASSUMPTIONS.md` entry, not a silent substitution.

**Stale-entry handling** (spec edge case "a defended file is deleted or renamed"): Stryker
keys incremental entries by file path and content hash and discards entries whose file no
longer exists, so a rename produces a full re-evaluation of the new path rather than a
resurrected result. No custom handling is required, but the docs task states this so a
reader does not distrust the file.

---

## R-005: CI placement — a new workflow file, not a new job in `ci.yml`

**Decision**: a new `.github/workflows/mutation.yml`. `ci.yml` is **not modified at all**.

**Rationale, from the repo**: `.github/workflows/ci.yml` currently holds exactly one job,
`gate`, which runs lint → typecheck → test → coverage → build, triggered on
`pull_request` (no path filter) and on `push` to `develop`, under
`concurrency: ci-${{ github.ref }}` with `cancel-in-progress: true`.

The repository holds a **second** workflow, `.github/workflows/release-gates.yml`: one job
`gates` running `scripts/verify-uat.sh`, `npm run test:recovery` and `npm run test:perf`,
triggered on `workflow_dispatch` and on `schedule` at `cron: '0 3 * * *'`. It is not a
pull-request gate and is not modified by this feature, but it matters twice over. FR-015
and FR-025 apply to it as much as to `ci.yml`, so the zero-diff evidence must cover both
files. And it already occupies the 03:00 nightly slot — GitHub queues scheduled workflows
and delays them under load, so the mutation schedule takes a different hour (`0 5 * * *`,
ci-job contract C-10.4) rather than competing with it for the same runner allowance.

Three facts force a separate file:

1. **Path filtering in GitHub Actions is workflow-level, not job-level.** FR-016 requires
   the mutation job to run only when a defended path changes. Adding `on.pull_request.paths`
   to `ci.yml` would apply that filter to the existing `gate` job too, and `gate` must keep
   running on every pull request. There is no job-level `paths` key.
2. **The shared `concurrency` group** would let a mutation run cancel, or be cancelled by,
   an unrelated `gate` run on the same ref.
3. FR-015 is easiest to *prove* when the existing file is untouched: an empty diff on
   `ci.yml` is the evidence.

**Consequence worth stating**: a separate workflow means a separate required-check name.
Nothing in this feature marks it required, which is what FR-015 wants — the mutation job
reports independently and blocks nothing.

**Scheduled runs**: GitHub only runs `schedule` triggers on the repository's **default
branch**. The nightly run of FR-017 therefore exercises the default branch only. Verified
on 2026-09-21 against the remote (`gh repo view --json defaultBranchRef` and
`git ls-remote --symref origin HEAD`): the default branch **is** `develop`, matching the
project's stated baseline, so FR-017 is satisfiable as specified. A local
`refs/remotes/origin/HEAD` can go stale and disagree; the remote is the authority. This is a platform constraint, not a
choice, and the docs record it so nobody reports the absence of nightly runs on a feature
branch as a bug.

---

## R-006: Interaction with the existing lint, type-check and boundary rules

**Decision**: the two new configuration files are `stryker.config.mjs` and
`jest.mutation.config.js`; both are added to the `ignores` array in `eslint.config.mjs`.

**Rationale, from the repo**: `eslint.config.mjs` applies the TypeScript and `boundaries`
rule blocks only to `files: ['**/*.ts']`, and `settings['boundaries/include']` is
`['src/**/*.ts']`. A `.mjs`/`.js` config file therefore matches no rule block and would
pass `eslint .` untouched — FR-026 is satisfied structurally, because a file outside
`src/**/*.ts` cannot participate in the layer graph at all.

The `ignores` entries are nonetheless added so the intent is explicit rather than
incidental, and because the existing `ignores` array already lists exactly this kind of
non-source config (`jest.config.ts`, `eslint.config.mjs`). This is an additive change
affecting only files that did not previously exist, so `npm run lint` behaves identically
on every pre-existing file (FR-025).

`tsconfig.json` needs **no** change: its `include` is `["src/**/*", "test/**/*"]`, so
neither new root-level config file is type-checked, and `npm run typecheck` is unaffected.

---

## R-007: The README link — resolved, previously deferred

**Finding (revised 2026-09-21, after PR #12 merged)**: `README.md` **exists** at the
repository root. FR-021's requirement that the README link to the dedicated docs file is
therefore satisfiable directly, with no conditional and no deferral.

**Decision**: write the documentation to `docs/testing-mutation.md` and add the link to
`README.md` unconditionally.

**Rationale**: `docs/` is the right home for the document itself — it already holds
`ASSUMPTIONS.md`, `kafka-acls.md` and `plans/`, so a testing document is consistent with
existing practice, and a topic of this size does not belong inline in a README.

The README's existing structure gives two natural insertion points, and the docs task uses
both:

- **`## Testing`** already lists the test commands one per line (`test:unit`, `test`,
  `test:cov`, `test:recovery`, `test:perf`, `docs:verify`). `test:mutation` belongs in that
  list, in the same form, so a reader finds it where they look for the others.
- **`## Further reading`** already links `docs/ASSUMPTIONS.md`, `docs/kafka-acls.md`,
  `docs/plans/` and `specs/`. `docs/testing-mutation.md` belongs there.

**Superseded reasoning, recorded so the change is auditable**: this research originally
found no `README.md` in the repository and deferred the link, because creating a stub would
have collided with feature **002-openapi-docs-readme** (karst ticket
`FEAT-11-OPENAPI-DOCS-README`), which owned that file as its own deliverable. Feature 002's
implementation has since merged as PR #12, which created the README. The collision hazard
is gone, the "whichever feature lands second owns the link" follow-through has resolved in
002's favour, and no `docs/ASSUMPTIONS.md` entry is owed for a deferral that no longer
exists.

**Consequence for FR-025**: PR #12 also added `npm run docs:verify`, a documentation drift
gate that did not exist when this feature's constraints were first written. It joins the
set of pre-existing commands that must behave exactly as before.

---

## R-008: Constitution obligations that apply to this feature

**Finding**: two principles bind work that adds no production code.

- **Principle VI (Test-First, NON-NEGOTIABLE)** mandates failing-test-first and 80%
  coverage. This feature adds configuration, a CI workflow, and documentation — no
  production source, and therefore nothing for a unit test to assert about. The verifiable
  behaviour is the mutation command's own exit status, and the plan makes it verifiable by
  requiring an explicit **negative** check: deliberately weaken an assertion in a scratch
  copy and prove the command exits non-zero. That is the red step, performed against the
  gate rather than against new production code.
- **Principle VII** requires every assumption or trade-off to be recorded in
  `docs/ASSUMPTIONS.md` with its rationale, and the merge gate (Workflow item 5) requires
  that file to be current. The entries owed are: the measured baseline and why the floor
  sits where it does; the perTest/typescript-checker budget trade-off; the separate-workflow
  choice; and the relocation of the retained prior-run state from R-004. The deferred
README link that this list originally carried has been struck: R-007 resolved once
`README.md` came into existence, and an assumption entry recording a deferral that no
longer applies would mislead rather than inform.

**Decision**: both are treated as required plan output, not optional polish.

---

## R-009: Scope patterns versus the files that exist today

**Measured**: the six FR-001 directories contain **32** `.ts` files and **3383** lines.
Applying the FR-002 exclusions (`*.module.ts`, `**/entities/**`, `**/dto/**`) to those six
directories removes **zero** files — every exclusion targets a path outside the defended
scope.

**Decision**: keep the FR-002 exclusion list in the configuration anyway.

**Rationale**: `mutate` patterns are evaluated against future contents, not today's. A
`dto/` folder appearing under `src/capacity/application/` later is entirely plausible, and
the exclusions cost nothing. Dropping them because they match nothing today would be
optimising against a snapshot.
