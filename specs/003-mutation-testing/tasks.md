---

description: "Task list for 003-mutation-testing"
---

# Tasks: Mutation Testing for Business-Logic Test Effectiveness

**Input**: Design documents from `/specs/003-mutation-testing/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: This feature adds no production source, so it adds no unit tests. It does carry
one mandatory **red step** (T023) proving the gate it installs can actually fail; that is
Constitution Principle VI's requirement discharged, not an optional extra.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- Paths are repository-relative from `/Users/nd/Work/projects/invoice-reservation`

## Ordering constraint specific to this feature

Phases 3 → 4 are **strictly sequential and cannot be parallelised**, unlike the usual
story independence: User Story 2's entire content is a number that only User Story 1's
baseline run can produce (FR-008, FR-009). Attempting US2 before US1 means inventing a
threshold, which FR-009 forbids outright. US3 depends on US2 only because the workflow
invokes the command whose exit status US2 defines.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Dependencies and version-control hygiene, before any configuration exists

- [ ] T001 Add three dev dependencies with matched versions in `package.json`: `@stryker-mutator/core`, `@stryker-mutator/jest-runner`, `@stryker-mutator/typescript-checker`. All three MUST resolve to the same major.minor; a mismatched runner and core is a documented Stryker failure mode. Install so `package-lock.json` is updated in the same change — both workflows install with `npm ci`, which fails outright when the lockfile disagrees with `package.json`.
- [ ] T002 Add the `test:mutation` script to `package.json` scripts, invoking Stryker against `stryker.config.mjs`. Do NOT alter, reorder or reformat any existing script entry: `test`, `test:unit`, `test:cov`, `test:recovery`, `test:perf`, `docs:verify`, `typecheck`, `lint`, `build`, `migration:*`, `seed`, `audit:ledger`, `reconcile` MUST remain byte-identical (FR-025). `docs:verify` is the documentation drift gate added by feature 002 in PR #12 — it postdates the spec's wording and is easy to overlook, but breaking it breaks a merge gate.
- [ ] T003 [P] Append `reports/` and `.stryker-tmp/` to `.gitignore`. The file currently holds exactly six entries (`node_modules/`, `dist/`, `coverage/`, `.env`, `*.log`, `.karst/worktrees/`) and has no negation rules; do not introduce one. `.stryker-incremental.json` at the repository root is deliberately NOT ignored — it is committed (FR-012, research R-004).
- [ ] T004 [P] Add `stryker.config.mjs` and `jest.mutation.config.js` to the `ignores` array in `eslint.config.mjs`. This edit is **defensive only**: both rule blocks in that file are scoped `files: ['**/*.ts']` and `settings['boundaries/include']` is `['src/**/*.ts']`, so the two new files already match no rule and already pass `npm run lint`. Add nothing else to the array and change no rule (FR-025, FR-026).

**Checkpoint**: `npm ci` succeeds, `npm run lint`, `npm run typecheck` and `npm run test:unit` behave exactly as before.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The two configuration files every later phase depends on

**⚠️ CRITICAL**: No measurement can be trusted until T005 exists. Pointing Stryker at the
existing `jest.config.ts` pulls the testcontainers-backed suites into every mutant run —
invisible until the run hangs.

- [ ] T005 Create `jest.mutation.config.js` at the repository root: plain CommonJS (`module.exports`), `preset: 'ts-jest'`, `testEnvironment: 'node'`, `rootDir: '.'`, `roots: ['<rootDir>/test/unit']`, `testRegex: '.*\\.spec\\.ts$'`, `moduleFileExtensions: ['js','json','ts']`. Deliberately omit `coverageThreshold` — the 80% global gate belongs to `npm run test:cov` alone and must not be evaluated per mutant. `roots` restricted to `test/unit` is a **structural** exclusion of the container-dependent sets, not a subtractive ignore (FR-003, research R-002). Plain `.js` rather than `.ts` avoids depending on Stryker's jest-runner resolving a TypeScript config.
- [ ] T006 Verify T005 in isolation before Stryker ever runs it: `npx jest --config jest.mutation.config.js --listTests` MUST list only paths under `test/unit/` — zero paths under `test/integration/`, `test/migration/`, `test/contract/` or `test/performance/`. A single path outside `test/unit/` means T005 is wrong; fix it before proceeding.
- [ ] T007 Create `stryker.config.mjs` at the repository root with: `testRunner: 'jest'`, `jest.configFile: 'jest.mutation.config.js'`, `checkers: ['typescript']`, `tsconfigFile: 'tsconfig.json'`, `coverageAnalysis: 'perTest'`, `reporters: ['html','clear-text','progress']`, `incremental: true`, `incrementalFile: '.stryker-incremental.json'`, and a per-variant `timeoutMS`. Leave `concurrency` at the Stryker default — a laptop and a 2–4 vCPU runner want different values and pinning one penalises the other. Do NOT add a `thresholds` block in this task; the floor is measured in Phase 4, and writing a guessed number here violates FR-009.
- [ ] T008 Set the `mutate` globs in `stryker.config.mjs` to exactly the six FR-001 directories — `src/capacity/domain/**/*.ts`, `src/capacity/application/**/*.ts`, `src/shared/money/**/*.ts`, `src/shared/result/**/*.ts`, `src/treasury/handlers/**/*.ts`, `src/treasury/retry/**/*.ts` — and the eight FR-002 negated exclusions: `!src/migrations/**`, `!src/config/**`, `!src/types/**`, `!src/main.ts`, `!**/*.module.ts`, `!**/entities/**`, `!**/dto/**`, `!src/observability/**`. The exclusions remove zero files from within the six directories today, as measured on 2026-09-21; keep them anyway, because the globs are evaluated against future contents and a `dto/` folder under `src/capacity/application/` is plausible (research R-009).
- [ ] T009 Verify the resolved scope matches the plan's measured figures: the set of files Stryker reports as mutated MUST be **32 files** totalling **3400 lines**, distributed `src/capacity/domain` 9, `src/capacity/application` 14, `src/shared/money` 4, `src/shared/result` 2, `src/treasury/handlers` 2, `src/treasury/retry` 1. A different count means a glob is wrong — reconcile before measuring anything.

**Checkpoint**: Configuration is complete and scoped correctly, with no threshold configured. User Story 1 can begin.

---

## Phase 3: User Story 1 - Measure how much of the business logic the tests really defend (Priority: P1) 🎯 MVP

**Goal**: One command produces a trustworthy effectiveness score plus a browsable report of every undetected change, on a machine with no container runtime.

**Independent Test**: On a clean checkout with no threshold configured and no automation, run the command; it completes and prints a score with four counts and writes a browsable report.

- [ ] T010 [US1] Confirm the precondition before measuring: run `npm run test:unit` and require it green. A run against an already-red suite reports a meaningless score, and the spec's edge case requires stopping and reporting the broken suite rather than a number. Record the observed suite size — 35 suites / 324 tests / ~6.9 s as measured on 2026-09-21 — and investigate any material divergence before continuing.
- [ ] T011 [US1] Execute the baseline run: `npm run test:mutation`, timed end to end (`time npm run test:mutation`). This is the FR-008 baseline. It runs with no `thresholds` block, so its exit status is not yet meaningful — the score is. Do not edit any configuration while this run is in flight.
- [ ] T012 [US1] Record the baseline verbatim from T011's output into `specs/003-mutation-testing/quickstart.md` Scenario 2's result slot: the overall score to one decimal place, and the four separate counts — detected (Killed), undetected (Survived), timed out (Timeout), never executed (NoCoverage). Record `CompileError` and `Ignored` separately if present. Do not round, do not estimate, do not reuse a number from any other document (FR-004, FR-008).
- [ ] T013 [P] [US1] Verify the no-container property empirically, which is the whole point of T005: stop the Docker daemon entirely (`docker context ls` to confirm nothing is reachable), then run `npm run test:mutation` again. It MUST complete normally. If it hangs or errors on a container, `jest.mutation.config.js` is not actually constraining the runner (FR-003, SC-003, US1 scenario 3).
- [ ] T014 [P] [US1] Verify report traceability against the HTML report: pick three undetected changes at random and confirm each shows source file, line number, original code and altered code, and that the file path falls inside the six defended directories. 100% traceability is SC-006; three samples failing means the reporter is misconfigured (FR-005, US1 scenario 2).
- [ ] T015 [US1] Verify the repository is unmodified by the run: `git status --porcelain` MUST show no modification to any file under `src/` or `test/`. The only expected additions are the ignored `reports/` and `.stryker-tmp/` plus `.stryker-incremental.json`. A modified test or source file means the run mutated in place rather than in its sandbox — stop and investigate (FR-023, FR-024, SC-005, US1 scenario 4).
- [ ] T016 [US1] Evaluate T011's measured wall-clock time against the 10-minute budget. If under budget, record the figure and proceed. If over, tune in this order and re-measure after each step: raise `concurrency`, lower per-variant `timeoutMS`, confirm `coverageAnalysis: 'perTest'` is actually in effect. Only if all three fail may scope be narrowed — and then the dropped directories and the reason MUST be named in `docs/testing-mutation.md`, never dropped silently (FR-012, FR-013, SC-002).
- [ ] T017 [US1] Commit `.stryker-incremental.json` as produced by the baseline run. This file is deliberately tracked while `reports/` and `.stryker-tmp/` are ignored (T003). Note for the reader: it is rewritten by every local run, so it will surface in unrelated diffs and should be committed deliberately rather than reflexively.

**Checkpoint**: A real, recorded baseline exists. The measurement stands on its own with no gate and no automation.

---

## Phase 4: User Story 2 - Fail the build when test effectiveness regresses (Priority: P2)

**Goal**: The measured baseline becomes an enforced floor that fails the command on regression.

**Independent Test**: With the floor configured, the unmodified repository exits zero; a scratch copy with assertions deleted exits non-zero.

**⚠️ Depends entirely on T012.** Every number in this phase is derived from that recorded baseline. There is no valid path into this phase that skips it.

- [ ] T018 [US2] Derive the three threshold values arithmetically from T012's recorded baseline, showing the arithmetic: `break` = baseline rounded **down** to the nearest multiple of 5; `low` = `break + 5`; `high` = `break + 10`; if `break + 10` exceeds 100 then `high` = 100 and `low` = 95. Inventing a number or using 100 is forbidden (FR-009, FR-010, contract C-2.5).
- [ ] T019 [US2] Write the derived `thresholds: { high, low, break }` block into `stryker.config.mjs`. `break` alone governs exit status; `high` and `low` are report colouring and aspiration only and MUST NOT affect it (FR-010, contract C-2.4).
- [ ] T020 [US2] Verify the configured floor equals the documented baseline's derivation by reading both: the value in `stryker.config.mjs` and the number recorded in `specs/003-mutation-testing/quickstart.md`. A mismatch between them is SC-009 failing.
- [ ] T021 [US2] Prove the green path: run `npm run test:mutation` against the unmodified repository and confirm exit status `0` (`echo $?`). Since the floor is the baseline floored to a multiple of 5, the unmodified repository is at or above it by construction; a non-zero exit here means the derivation in T018 is wrong (FR-011, US2 scenario 1).
- [ ] T022 [US2] Confirm the failure output is actionable before relying on it: the run must state both the achieved score and the floor it missed, not merely fail. Verified as part of T023's output (contract C-2.2, SC-004).
- [ ] T023 [US2] **The red step — mandatory, and the reason Constitution Principle VI passes for this feature.** In a scratch copy only (`git worktree add` or a copy outside the working tree — never on the working branch), delete assertions from one unit test covering the defended scope, run `npm run test:mutation`, and confirm a **non-zero** exit naming the score and the floor. Then discard the scratch copy entirely. A gate that has never been seen to fail is not a gate. The weakened test MUST NOT reach a commit — FR-023 forbids weakening any test, and this copy exists solely to prove the gate fires (US2 scenario 2, SC-004, quickstart Scenario 4).
- [ ] T024 [US2] Verify the discard was complete: `git status --porcelain` clean of any test modification, and `git worktree list` showing no leftover scratch worktree. This closes the one window in this feature where a weakened test exists anywhere on disk.

**Checkpoint**: The floor is installed, derived from measurement, and has been observed both passing and failing.

---

## Phase 5: User Story 3 - Run the check automatically and keep the evidence (Priority: P3)

**Goal**: The check runs on relevant pull requests and nightly, leaves a downloadable report, and disturbs no existing gate.

**Independent Test**: A pull request touching a defended directory starts the mutation job; the existing jobs run exactly as before; the report downloads from the finished run.

- [ ] T025 [US3] Create `.github/workflows/mutation.yml` as a **new** file. Do not add a job to `.github/workflows/ci.yml`: GitHub Actions path filters are workflow-level (`on.pull_request.paths`) and there is no job-level `paths` key, so filtering inside `ci.yml` would suppress its existing `gate` job on pull requests touching no defended path — a direct FR-015 violation (contract C-9.1, research R-005).
- [ ] T026 [US3] Configure the workflow's triggers: `on.pull_request.paths` listing the six FR-001 directories plus `stryker.config.mjs`, `jest.mutation.config.js`, `package.json` and `package-lock.json`. The lockfile is listed explicitly because a dependency bump that moves only the lockfile — a Stryker patch release — changes the gate's behaviour while touching no other filtered path, and would otherwise slip through unexercised (FR-016, contract C-10.3).
- [ ] T027 [US3] Add the nightly trigger `schedule: - cron: '0 5 * * *'` to `.github/workflows/mutation.yml`. It MUST NOT be `0 3 * * *`, which `.github/workflows/release-gates.yml` already occupies: GitHub queues scheduled workflows and delays them under load, so two nightly runs on the same hour compete for the same runner allowance and both arrive late (FR-017, contract C-10.4).
- [ ] T028 [US3] Set the workflow's `concurrency` group to exactly `mutation-${{ github.ref }}`. It MUST differ from `ci.yml`'s `ci-${{ github.ref }}`, which carries `cancel-in-progress: true` — a shared group would let a mutation run cancel, or be cancelled by, an unrelated CI run on the same ref (contract C-9.4).
- [ ] T029 [US3] Configure the job body: `runs-on: ubuntu-latest`, `timeout-minutes: 20`, `actions/checkout@v7`, `actions/setup-node@v7` with `node-version: '22'` and `cache: npm`, then `npm ci`, then `npm run test:mutation`. The timeout sits above the 10-minute budget so a merely slow run still reports, and well below `ci.yml`'s 30 so a runaway fails fast. Declare no service container and no repository secret — the run is container-free by construction and has nothing to leak (contract C-13, Constitution V).
- [ ] T030 [US3] Add the HTML report upload step with an **always-run** condition (`if: always()`), not the default. A failing run is exactly when the surviving variants need inspecting, so the artefact must survive a threshold failure (FR-018, contract C-12, SC-010).
- [ ] T031 [US3] Verify the workflow declares no `needs:` on any existing job, and that no existing job declares the mutation job as a prerequisite. The mutation job blocks nothing by design and MUST NOT be configured as a required status check by this feature (FR-015, contract C-11.2/C-11.3).
- [ ] T032 [P] [US3] Prove non-interference by diff, which is the cleanest available evidence: `git diff -- .github/workflows/ci.yml .github/workflows/release-gates.yml` MUST be **empty**. The repository holds **two** existing workflows, not one — `release-gates.yml` runs `scripts/verify-uat.sh`, `npm run test:recovery` and `npm run test:perf` on `workflow_dispatch` and nightly — and FR-015 covers both (contracts C-9.2 and C-9.2a).
- [ ] T033 [P] [US3] Verify the positive trigger: open a pull request changing one file under `src/shared/money/**` and confirm the mutation job executes (FR-016, US3 scenario 1).
- [ ] T034 [P] [US3] Verify the negative trigger: open a pull request changing only files under `docs/**` and confirm the mutation job does **not** execute, while `ci.yml`'s `gate` job does (FR-016, SC-007, US3 scenario 2).
- [ ] T035 [US3] Verify isolation under failure: with a run that fails the threshold, confirm the pre-existing lint, type-check, test, coverage and build gates report exactly what they would have reported before this feature existed (FR-015, SC-008, US3 scenario 3).
- [ ] T036 [US3] Download the artefact from both a passing run and a failing run, confirming T030's always-run condition actually holds in practice rather than only in the YAML (FR-018, US3 scenario 4).

**Checkpoint**: All three stories are independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T037 Create `docs/testing-mutation.md` covering all five FR-020 topics: how to run locally; where the report is written; how to read an undetected change; the decision rule for adding a test versus suppressing a change; and why the floor sits where it does, quoting T012's baseline and T018's arithmetic. Written so a developer unfamiliar with mutation testing can act on a surviving variant without further help (SC-011).
- [ ] T038 Add three further notes to `docs/testing-mutation.md`, each of which prevents a correct behaviour being filed as a defect: that `schedule` triggers run only on the repository's default branch — verified on 2026-09-21 as `develop` via `gh repo view --json defaultBranchRef` and `git ls-remote --symref origin HEAD` — so the absence of nightly runs on a feature branch is expected; that a renamed or deleted defended file produces a full re-evaluation rather than a resurrected prior result, because Stryker keys incremental entries by path and content hash; and that `.stryker-incremental.json` is rewritten by every local run and so appears in unrelated diffs.
- [ ] T039 State the suppression rule explicitly in `docs/testing-mutation.md`: every `// Stryker disable` MUST carry an inline written justification on the same line or immediately above. A bare suppression is forbidden, because suppression without justification is indistinguishable from hiding a real gap — and `CompileError` and `Ignored` variants are excluded from the score's denominator precisely so suppression cannot be used to raise it (FR-022).
- [ ] T040 Add the four required entries to `docs/ASSUMPTIONS.md`, each with its rationale: (1) the measured baseline and the derivation of the floor; (2) the `coverageAnalysis: 'perTest'` plus TypeScript-checker budget trade-off; (3) the separate-workflow decision and why a second job in `ci.yml` cannot satisfy the path filter; (4) the relocation of the retained prior-run state from the requested `.stryker-tmp/incremental.json` to `.stryker-incremental.json` at the repository root, because `.stryker-tmp/` is Stryker's own sandbox — scratch space created and torn down around a run — so a file committed inside it is not durable. The behaviour requested is unchanged; only the path differs. Constitution Principle VII and merge-gate item 5 make this file's currency a merge blocker (FR-020).
- [ ] T041 Link `docs/testing-mutation.md` from `README.md` in two places, matching the file's existing conventions rather than inventing a new section: add `- \`npm run test:mutation\` — mutation suite, no Docker.` to the `## Testing` list, in the same one-line form as the five commands already there; and add `- [Mutation testing](docs/testing-mutation.md)` to the `## Further reading` list, which already links `docs/ASSUMPTIONS.md`, `docs/kafka-acls.md`, `docs/plans/` and `specs/`. This satisfies FR-021 unconditionally. An earlier revision of this task was conditional on `README.md` existing and forbade creating a stub, because the README was feature 002's deliverable; 002 merged in PR #12 and the file now exists, so the condition is settled and the collision hazard is gone (research R-007). Verify `npm run docs:verify` still passes after the edit — it is a documentation drift gate and the README is within its remit.
- [ ] T042 Run the full quickstart end to end: `specs/003-mutation-testing/quickstart.md` Scenarios 1 through 6 plus the repository hygiene check, confirming each stated expectation. Scenario 2 produces the number Scenario 3 configures, so run them in order.

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
```

Expected:

- The seven pre-existing commands behave exactly as they did before this feature, including the 80% global coverage threshold and the documentation drift gate (FR-025, SC-008).
- `npm run test:mutation` exits `0`, at or above the configured floor.
- Both workflow diffs are empty (FR-015).
- `git status --porcelain` shows no modification under `src/` or `test/` (FR-023, FR-024, SC-005).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Phase 1. BLOCKS all stories. T005 must precede T007 — Stryker's config references the Jest config by filename.
- **US1 (Phase 3)**: Depends on Phase 2 complete, T009 included.
- **US2 (Phase 4)**: Depends on **T012 specifically**. Not merely on Phase 3 finishing — on that one recorded number existing.
- **US3 (Phase 5)**: Depends on Phase 4, since the workflow's value rests on the command's exit status meaning something.
- **Polish (Phase 6)**: T037 and T040 depend on T012 and T018 for the numbers they quote.

### Parallel Opportunities

- T003 and T004 in parallel — different files, neither depends on the other.
- T013, T014 in parallel after T011; T015 needs the run finished.
- T032, T033, T034 in parallel once `mutation.yml` exists.
- **Phases 3, 4 and 5 cannot be parallelised across developers.** This is the exception to the usual story-independence rule, and it is inherent: the floor is derived from the baseline, and the automation asserts on the floor.

---

## Implementation Strategy

### MVP (User Story 1 only)

Phases 1 → 2 → 3, then stop and validate. At that point the team has a real measurement
of where its assertions are hollow, with no gate and no automation — which is already the
larger half of this feature's value, and is useful even if Phases 4–6 are never done.

### Incremental Delivery

1. Phases 1–2 → configuration exists, scoped and verified, no threshold.
2. Phase 3 → baseline measured and recorded. **MVP.**
3. Phase 4 → floor installed, observed passing and failing.
4. Phase 5 → automated, evidence retained, nothing else disturbed.
5. Phase 6 → documented, assumptions recorded, merge-gate satisfied.

---

## Notes

- [P] = different files, no dependency.
- T023 is the only task that deliberately leaves a weakened test on disk, in a scratch copy only, and T024 exists to confirm it is gone. Do not commit between them.
- Commit after each task or logical group.
- This feature adds no `src/` file and no import, so `boundaries/dependencies` has nothing new to evaluate (FR-026).
