# Feature Specification: Mutation Testing for Business-Logic Test Effectiveness

**Feature Branch**: `003-mutation-testing`

**Created**: 2026-09-21

**Status**: Draft

**Input**: User description: "Add mutation testing to verify the existing test suite actually detects meaningful code changes."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Measure how much of the business logic the tests really defend (Priority: P1)

A developer wants to know whether the existing unit tests actually fail when business
logic changes, rather than merely executing the lines. They run one command, and after a
bounded wait they get a single effectiveness score for the money, ledger, reservation,
and treasury-handling logic, together with a browsable report listing every deliberate
change the suite failed to notice, each traceable to file and line.

**Why this priority**: Without a measured baseline nothing else in this feature can be
configured — the enforcement threshold (User Story 2) is derived from this number, and
the report format (User Story 3) is what makes the number actionable. It also stands
alone: even with no gate and no automation, the measurement by itself tells the team
where its assertions are hollow.

**Independent Test**: Run the mutation command on a clean checkout with no threshold
configured and no automation in place. It completes and prints a score plus a count of
detected, undetected, timed-out, and never-executed changes, and writes a browsable
report.

**Acceptance Scenarios**:

1. **Given** a clean checkout with a passing unit test suite, **When** a developer runs
   the documented mutation command, **Then** the run completes and reports an
   effectiveness score with the counts of detected, undetected, timed-out, and
   never-executed changes.
2. **Given** a completed run, **When** the developer opens the generated report, **Then**
   every undetected change is listed with its source file, line number, the original
   code, and the altered code.
3. **Given** the machine has no container runtime available, **When** the developer runs
   the mutation command, **Then** the run still completes, because only the container-free
   portion of the suite is exercised.
4. **Given** a completed run, **When** the developer inspects the repository, **Then** no
   test file and no production source file has been modified by the run.

---

### User Story 2 - Fail the build when test effectiveness regresses (Priority: P2)

A reviewer wants a change that removes or weakens an assertion in the defended logic to
be caught automatically, rather than relying on someone noticing. The measured baseline
becomes a floor: any later run scoring below it exits with a failure.

**Why this priority**: Enforcement is only meaningful once the baseline exists, and the
number must be measured rather than invented — a guessed floor either blocks all work or
protects nothing. Independently valuable because it converts a one-off audit into a
standing guarantee.

**Independent Test**: With the floor configured at the measured baseline, run the command
unchanged and observe a zero exit status; then, in a scratch copy, delete assertions from
one unit test and observe a non-zero exit status.

**Acceptance Scenarios**:

1. **Given** the floor is configured at the measured baseline, **When** the mutation
   command runs against the unmodified repository, **Then** it exits with a success
   status.
2. **Given** the floor is configured, **When** a run scores below the floor, **Then** the
   command exits with a non-zero status and states the score and the floor it missed.
3. **Given** the floor is being chosen, **When** it is written into configuration,
   **Then** it equals the measured baseline rounded down to the nearest multiple of five,
   and the aspirational levels sit above it.

---

### User Story 3 - Run the check automatically and keep the evidence (Priority: P3)

A reviewer opening a pull request that touches the defended logic wants the effectiveness
check to run on its own and leave behind an inspectable report, without that check
delaying or destabilising the existing build, lint, type, and test gates. The same check
also runs on a nightly schedule so drift is caught even when nobody touches those paths.

**Why this priority**: Automation multiplies the value of the first two stories but
depends on both. It is last because a developer can already get the full benefit locally.

**Independent Test**: Open a pull request touching one of the defended directories,
confirm the mutation job starts, confirm the existing jobs run exactly as they did
before, and confirm the report is downloadable from the finished run.

**Acceptance Scenarios**:

1. **Given** a pull request that changes a file inside the defended directories, **When**
   the automation runs, **Then** the mutation job executes.
2. **Given** a pull request that changes no file inside the defended directories, **When**
   the automation runs, **Then** the mutation job does not execute.
3. **Given** the mutation job fails, **When** the pull request is evaluated, **Then** the
   pre-existing build, lint, type-check, and test gates report exactly the result they
   would have reported before this feature existed.
4. **Given** any completed mutation job, **When** a reviewer opens the run, **Then** the
   browsable report is available for download.
5. **Given** the nightly schedule fires, **When** the mutation job runs, **Then** it
   executes over the full defended scope regardless of what changed.

---

### Edge Cases

- **A defended file has no covering test at all.** Its changes are reported as never
  executed rather than silently ignored, and they count against the score.
- **A change causes an infinite loop.** The run bounds each altered variant with a time
  limit and records a timeout instead of hanging the whole run.
- **The unit suite is already failing before the run starts.** The run stops immediately
  and reports the broken suite, rather than reporting a meaningless score.
- **A change is provably impossible to detect** (for example, one that produces an
  equivalent program). It is suppressed only with an inline justification recorded next to
  the suppression; a bare suppression is not acceptable.
- **The run exceeds the time budget.** The scope is narrowed and the dropped directories
  are named with the reason, rather than the budget silently slipping.
- **A defended file is deleted or renamed** between runs. The reused prior-run state does
  not resurrect results for code that no longer exists.
- **Two runs on identical code** produce the same score; the score is not sensitive to
  machine speed except through timeouts, and timeouts are reported separately so this is
  visible.
- **A developer runs the command with no container runtime.** The run is unaffected,
  because container-dependent tests are outside the exercised set.

## Requirements *(mandatory)*

### Functional Requirements

**Scope of measurement**

- **FR-001**: The system MUST measure test effectiveness over exactly these source areas:
  `src/capacity/domain/**`, `src/capacity/application/**`, `src/shared/money/**`,
  `src/shared/result/**`, `src/treasury/handlers/**`, `src/treasury/retry/**`.
- **FR-002**: The system MUST exclude from measurement: `src/migrations/**`,
  `src/config/**`, `src/types/**`, `src/main.ts`, every `*.module.ts`, every
  `**/entities/**` path, every `**/dto/**` path, and `src/observability/**`.
- **FR-003**: The system MUST exercise only the container-free unit test set
  (`test/unit`) when evaluating altered code. Exercising the container-dependent
  integration, migration, contract, or performance sets during a mutation run is
  FORBIDDEN.

**Measurement and reporting**

- **FR-004**: The system MUST report, for each run, the overall effectiveness score and
  the counts of detected, undetected, timed-out, and never-executed changes.
- **FR-005**: The system MUST produce a browsable report in which every undetected change
  is traceable to its source file, line number, original code, and altered code.
- **FR-006**: The system MUST emit live progress while a run is in flight and a
  human-readable summary on completion, so a run that is slow is distinguishable from a
  run that is stuck.
- **FR-007**: The system MUST write all generated artefacts to paths excluded from version
  control, except for the deliberately retained prior-run state named in FR-012.

**Baseline and enforcement**

- **FR-008**: A baseline run MUST be performed over the FR-001 scope before any
  enforcement floor is configured, and its score MUST be recorded in the feature
  documentation.
- **FR-009**: The enforcement floor MUST be set to the measured baseline score rounded
  down to the nearest multiple of five. Choosing the floor without a measurement, or
  setting it to 100, is FORBIDDEN.
- **FR-010**: Aspirational target levels MUST be configured above the enforcement floor
  and MUST NOT affect the exit status.
- **FR-011**: The mutation command MUST exit non-zero when the score falls below the
  enforcement floor and zero otherwise.

**Run time**

- **FR-012**: A full run MUST complete within 10 minutes on the automation runner. The
  system MUST use bounded parallelism, a per-variant time limit, and retained prior-run
  state to meet this.
- **FR-013**: If the 10-minute budget cannot be met over the full FR-001 scope, the scope
  MUST be narrowed and the omitted directories and the reason MUST be recorded in the
  feature documentation. Silently exceeding the budget is FORBIDDEN.

**Automation**

- **FR-014**: The mutation check MUST run as an automation job separate from the existing
  build, lint, type-check, and test jobs.
- **FR-015**: The mutation job MUST NOT be a prerequisite of, alter the behaviour of, or
  change the pass/fail outcome of any pre-existing automation job.
- **FR-016**: The mutation job MUST trigger on pull requests that touch any path listed in
  FR-001, and MUST NOT trigger on pull requests that touch none of them.
- **FR-017**: The mutation job MUST also trigger on a nightly schedule over the full
  FR-001 scope.
- **FR-018**: The mutation job MUST retain the browsable report as a downloadable
  artefact of the run.

**Invocation and documentation**

- **FR-019**: The system MUST expose a single documented command that performs a full
  mutation run.
- **FR-020**: Documentation MUST cover: how to run the check locally, where the report is
  written, how to read an undetected change, the decision rule for adding a test versus
  suppressing a change, and why the enforcement floor sits where it does.
- **FR-021**: If the documentation lives in a dedicated file, the project README MUST link
  to it.
- **FR-022**: Every suppression of an individual change MUST carry an inline written
  justification. Suppressions without one are FORBIDDEN.

**Non-interference**

- **FR-023**: Modifying, weakening, skipping, or deleting any existing test in order to
  raise the score is FORBIDDEN.
- **FR-024**: Production behaviour MUST NOT change. Refactoring production code for
  testability is out of scope for this feature.
- **FR-025**: The pre-existing commands for the full test run, the unit test run, the
  coverage run with its 80% global threshold, type-checking, linting, and the build MUST
  behave exactly as they did before this feature.
- **FR-026**: New configuration MUST NOT introduce an import that violates the project's
  enforced layer-dependency rules.

### Key Entities

- **Defended scope**: the set of source paths whose test effectiveness is measured,
  defined by FR-001 and FR-002.
- **Altered variant**: one deliberate, machine-generated change to a single point in a
  defended source file, whose fate is one of detected, undetected, timed out, or never
  executed.
- **Effectiveness score**: the proportion of altered variants the unit suite detected,
  expressed as a percentage.
- **Enforcement floor**: the score below which the command fails, derived from the
  baseline per FR-009.
- **Effectiveness report**: the browsable artefact listing every altered variant with its
  location, its original and altered code, and its fate.
- **Prior-run state**: the retained record of a previous run that lets a later run skip
  re-evaluating unchanged code, subject to FR-012 and the rename edge case.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer with a clean checkout obtains a full effectiveness score by
  running one documented command, with no prior setup beyond installing dependencies.
- **SC-002**: A full run finishes in under 10 minutes on the automation runner, or the
  narrowed scope and its reason are recorded.
- **SC-003**: A run on a machine with no container runtime succeeds.
- **SC-004**: Introducing a deliberate weakening of an existing assertion in the defended
  scope causes the command to exit non-zero.
- **SC-005**: The repository is byte-identical before and after a run, apart from
  generated artefacts and the retained prior-run state.
- **SC-006**: 100% of undetected changes in the report are traceable to a source file and
  line number.
- **SC-007**: On a pull request touching only files outside the defended scope, the
  mutation job does not run.
- **SC-008**: Across ten consecutive runs on unchanged code, the pre-existing build,
  lint, type-check, test, and coverage gates produce the same results they produced before
  this feature.
- **SC-009**: The enforcement floor recorded in configuration equals the documented
  baseline rounded down to the nearest multiple of five.
- **SC-010**: A reviewer can download the effectiveness report from any completed
  automated run.
- **SC-011**: A developer unfamiliar with mutation testing can, using the documentation
  alone, decide whether a given undetected change warrants a new test or a justified
  suppression.

## Assumptions

- The tooling is StrykerJS (`@stryker-mutator/core` with its Jest runner and TypeScript
  checker), named outright by the requester; no alternative is evaluated.
- The container-free unit set at `test/unit` (29 spec files at time of writing) is green
  before any mutation run; a red suite is a precondition failure, not a low score.
- The defended scope holds 32 source files today, and the file list is expected to grow;
  the scope is expressed as directory patterns so new files are covered automatically.
- The automation platform is the project's existing GitHub Actions setup
  (`.github/workflows/ci.yml` plus `release-gates.yml`); the new job may live in either an
  existing or a new workflow file provided FR-015 holds.
- Node 22.x, as already required by the project, is available on the automation runner.
- The baseline score is unknown until measured; no number is assumed anywhere in this
  specification.
- Retained prior-run state is committed to version control so that automation runs benefit
  from it, and is the single exception to FR-007.
- "Nightly" means once per day at a fixed hour; the exact hour is an implementation
  detail.
- Raising the effectiveness score by writing new tests is valuable but out of scope here:
  this feature delivers the measurement, the floor, the automation, and the documentation.
