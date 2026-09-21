# Contract: The Automated Mutation Job

**Feature**: 003-mutation-testing | **Date**: 2026-09-21

---

## C-9. Placement

- **C-9.1** — The job MUST live in a **new** workflow file,
  `.github/workflows/mutation.yml`. (FR-014)
- **C-9.2** — `.github/workflows/ci.yml` MUST have a **zero diff**. Its single `gate` job
  (lint → typecheck → test → coverage → build, on `pull_request` and on `push` to
  `develop`, under `concurrency: ci-${{ github.ref }}` with `cancel-in-progress: true`)
  MUST remain exactly as it is. (FR-015)
- **C-9.2a** — `.github/workflows/release-gates.yml` MUST likewise have a **zero diff**.
  The repository holds **two** workflows, not one; the second runs `verify-uat.sh`,
  `test:recovery` and `test:perf` on `workflow_dispatch` and on `cron: '0 3 * * *'`.
  FR-015's "existing checks unchanged" covers both files, and the zero-diff evidence
  MUST be produced for both.
- **C-9.3** — The mutation job MUST NOT be declared a `needs:` prerequisite of any existing
  job, and no existing job may declare it as one. (FR-015)
- **C-9.4** — The mutation workflow MUST use its **own** `concurrency` group, fixed as
  `mutation-${{ github.ref }}`, distinct from `ci.yml`'s `ci-${{ github.ref }}`, so a
  mutation run can neither cancel nor be cancelled by an unrelated CI run. (R-005)

**Why a separate file and not a second job in `ci.yml`**: GitHub Actions path filters are
**workflow-level** (`on.pull_request.paths`), never job-level. Adding the FR-016 filter to
`ci.yml` would suppress the existing `gate` job on pull requests that touch no defended
path — a direct FR-015 violation. There is no job-level `paths` key to reach for.

## C-10. Triggers

- **C-10.1** — On `pull_request`, the workflow MUST run when a changed file matches any
  FR-001 path. (FR-016, US3 scenario 1)
- **C-10.2** — On `pull_request`, it MUST NOT run when no changed file matches. (FR-016,
  SC-007, US3 scenario 2)
- **C-10.3** — The `paths` filter MUST also include the feature's own configuration files
  — `stryker.config.mjs`, `jest.mutation.config.js`, `package.json`, `package-lock.json` —
  so a change to the gate itself is exercised by the gate. `package-lock.json` is listed
  explicitly because a dependency bump that moves only the lockfile (a Stryker patch
  release, for instance) changes the gate's behaviour while touching no other filtered
  path, and would otherwise slip through unexercised.
- **C-10.4** — The workflow MUST additionally run on a `schedule`, once per day at a fixed
  hour, over the full scope regardless of what changed. (FR-017, US3 scenario 5) The hour
  is fixed at `cron: '0 5 * * *'`. It MUST NOT be `0 3 * * *`, which `release-gates.yml`
  already occupies: GitHub queues scheduled workflows and delays them under load, so two
  nightly runs on the same hour compete for the same runner allowance and both arrive
  later than intended.

**Platform constraint, not a choice**: GitHub runs `schedule` triggers only on the
repository's **default branch**. The nightly run therefore exercises the default branch
only; the project's stated baseline branch is `develop`. This MUST be stated in
`docs/testing-mutation.md` so the absence of nightly runs on a feature branch is not
reported as a defect. (R-005)

## C-11. Isolation from the existing gates

- **C-11.1** — When the mutation job **fails**, the pre-existing build, lint, type-check
  and test gates MUST report exactly the result they would have reported before this
  feature existed. (FR-015, US3 scenario 3)
- **C-11.2** — The mutation job MUST NOT be configured as a required status check by this
  feature. Blocking nothing is the intent. (FR-015)
- **C-11.3** — The job MUST require no repository secret. (Constitution V — nothing to
  leak)

## C-12. Artefact retention

- **C-12.1** — Every completed mutation job, pass or fail, MUST upload the HTML report as
  a downloadable build artefact. (FR-018, SC-010)
- **C-12.2** — Upload MUST occur even when the job fails the threshold, since a failing run
  is exactly when the surviving variants need inspecting. This requires an
  always-run condition on the upload step, not a default one.

## C-13. Runner environment

- **C-13.1** — `ubuntu-latest`, Node `22` with npm caching, matching `ci.yml`'s existing
  setup and the project's `engines: >=22.0.0 <23`.
- **C-13.2** — Dependencies installed with `npm ci`, matching `ci.yml`.
- **C-13.3** — No Docker service container is declared; the run is container-free by
  construction. (FR-003)
- **C-13.4** — A job-level `timeout-minutes: 20` MUST be set — above the 10-minute budget
  so a merely slow run still reports, and well below `ci.yml`'s 30 so a runaway run fails
  fast rather than consuming the full allowance.

---

## Verification matrix

| Assertion | How verified |
|---|---|
| C-9.1, C-9.2, C-9.2a | `git diff` on `.github/workflows/ci.yml` **and** `release-gates.yml` is empty |
| C-9.3, C-9.4 | Read `mutation.yml`; confirm no `needs:` and a distinct concurrency group |
| C-10.1 | PR touching `src/shared/money/**`; job runs |
| C-10.2 | PR touching only `docs/**`; job does not run |
| C-10.4 | Observe a scheduled run on the default branch |
| C-11.1 | Force a mutation failure; confirm `gate` still reports normally |
| C-12.1, C-12.2 | Download the artefact from both a passing and a failing run |
| C-10.4 (hour) | Read the cron expression; confirm it is not `0 3 * * *` |
| C-13.4 | Read the job's `timeout-minutes`; expect `20` |
