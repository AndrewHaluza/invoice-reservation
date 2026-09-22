# Feature Specification: Configurable Log Level

**Feature Branch**: `005-configurable-log-level`

**Created**: 2026-09-22

**Status**: Draft

**Input**: User description: "Make the service's log verbosity configurable through the environment, so an automated test run does not bury its own result under tens of thousands of per-request log lines."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Read a test run's result without scrolling past the logs (Priority: P1)

An engineer, or a reviewer opening a CI job, runs the full automated test suite and wants to know one thing: did it pass, and if not, which assertion failed. Today the suite emits one structured log record for every HTTP request any test makes. A single suite issues twenty thousand of those. The pass/fail summary is printed last, beneath all of them, and in a CI web console the surrounding output is either truncated or too large to scroll. The engineer cannot answer the question without downloading the raw log and searching it.

After this change, a test run emits no routine per-request records. Failures, and anything the service itself reports as a problem, still appear. The result summary is visible immediately at the end of the output.

**Why this priority**: This is the reported defect and the only reason the feature exists. It is also the whole of the value: an automated gate whose verdict cannot be read is not serving as a gate. Nothing else in this feature delivers value on its own.

**Independent Test**: Run the full automated suite and capture its console output. Confirm the run's result summary falls within the last lines of that output, that no routine request record appears anywhere in it, and that the suite's pass/fail verdict is unchanged from before.

**Acceptance Scenarios**:

1. **Given** the full automated test suite, **When** it is run with no log-related setting supplied by the operator, **Then** the console output contains no routine per-request record, and the run's result summary is visible without scrolling past unrelated output.
2. **Given** a test that provokes a genuine service-side error, **When** the suite runs, **Then** the record describing that error still appears in the output.
3. **Given** the full automated test suite, **When** it is run before and after this change, **Then** the set of passing and failing tests is identical.

---

### User Story 2 - Choose the verbosity of a running service (Priority: P2)

An operator running the service — locally against the development stack, or in a deployed environment — wants to turn verbosity up while diagnosing an incident and back down afterwards, without editing source or redeploying a different build. Today the level is fixed in code at the framework's default and there is no setting that changes it.

**Why this priority**: Genuinely useful and the natural shape of the fix, but the service is operable today at its current fixed verbosity. This is an improvement, not a defect.

**Independent Test**: Start the service twice with different values of the new setting and confirm that the volume and kind of records it emits differ accordingly, with no change to its functional behaviour.

**Acceptance Scenarios**:

1. **Given** a running service, **When** the operator supplies a recognised verbosity value, **Then** the service emits records at that verbosity and no records below it.
2. **Given** a running service, **When** the operator supplies no verbosity value, **Then** the service behaves exactly as it does today.
3. **Given** the service, **When** the operator supplies a value that is not a recognised verbosity, **Then** the service refuses to start and names the offending setting and the values it accepts.

---

### User Story 3 - Keep the environment contract honest (Priority: P3)

The project enforces that its published environment template declares exactly the settings the service requires — no more, no less — and fails its acceptance gate on any drift. A new setting that is added in one place and not the other breaks that gate.

**Why this priority**: A consequence of the other two rather than a goal in itself, but it is a hard gate: skipping it turns a green build red for an unrelated-looking reason.

**Independent Test**: Run the project's acceptance verification and confirm the environment-parity section passes.

**Acceptance Scenarios**:

1. **Given** the new setting exists, **When** the acceptance verification runs, **Then** its environment-parity check passes and the new setting is present in both the template and the validated schema.

---

### Edge Cases

- **An unrecognised verbosity value.** The service refuses to start, naming the setting and the accepted values, consistent with how it already treats every other invalid setting. It does not silently fall back to a default — a typo that quietly disables logging is worse than a failed boot.
- **An empty value.** Treated as "not supplied": the default applies. An operator who exports the variable with no value has expressed no preference.
- **Verbosity raised above the routine level during a test run.** Permitted. An engineer debugging a specific failure can ask for the full request records back, and gets exactly today's behaviour.
- **Verbosity set to suppress everything, including errors.** Permitted, and the operator's choice. It is recorded as a supported value rather than special-cased, because the test run's own default depends on suppression working.
- **A record that would leak a credential.** Unaffected by this feature. The existing redaction of authorisation headers, cookies and API keys applies at every verbosity; lowering verbosity must never be the thing that keeps a secret out of the log, and raising it must never put one in.
- **Deployed environments that set nothing.** Behaviour is unchanged from today. The default must not quieten a production service as a side effect of fixing a test-output problem.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The service MUST accept a log verbosity level as an environment setting.
- **FR-002**: The service MUST validate that setting at startup against a fixed set of recognised verbosity values, and MUST refuse to start on an unrecognised value, naming the setting and the accepted values.
- **FR-003**: The service MUST default, when the setting is absent or empty, to the verbosity it emits today, so that no deployed environment changes behaviour on upgrade.
- **FR-004**: The service MUST apply the configured verbosity to every record it emits, including the per-request records, and MUST NOT emit records below the configured verbosity.
- **FR-005**: An automated test run MUST, with no operator-supplied setting, suppress routine per-request records while still emitting records that describe a genuine failure.
- **FR-006**: An engineer MUST be able to restore full per-request records for a single test run by supplying the setting, without editing any file.
- **FR-007**: The published environment template MUST declare the new setting, and the validated schema MUST declare it too, so that the project's existing template-versus-schema parity gate passes. "Declare" here means the schema knows the key and validates it — the setting itself stays optional, because FR-003 requires an absent value to be legal.
- **FR-008**: The redaction of authorisation headers, cookies and API keys MUST remain in force at every verbosity, and MUST NOT be weakened, bypassed or made conditional on the level.
- **FR-009**: This feature MUST NOT change the pass or fail outcome of any existing test, nor any observable service behaviour other than which records are emitted.
- **FR-010**: The project's documentation MUST describe the new setting, its accepted values, its default, and how to raise verbosity for a single test run.

### Key Entities

- **Log verbosity level**: A single named threshold, drawn from an ordered set running from most verbose to fully suppressed. A record is emitted only when its own severity is at or above the configured threshold. It has exactly one value at a time for a given process, fixed at startup.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A reader can determine whether the full automated test suite passed by reading the last 25 lines of its console output, with no filtering, searching or scrolling.
- **SC-002**: A full automated test-suite run produces no routine per-request record in its console output — down from more than twenty thousand such records today.
- **SC-003**: The set of tests that pass, and the set that fail, is byte-for-byte identical before and after the change.
- **SC-004**: A service started with no verbosity setting emits the same records, at the same severities, as it does today.
- **SC-005**: A service started with an unrecognised verbosity value fails to start, and its failure message names both the setting and the accepted values.
- **SC-006**: The project's acceptance verification passes, including its environment template-versus-schema parity check.
- **SC-007**: An engineer can restore full per-request records for one test run by supplying a single environment setting on the command line, and doing so requires no file edit.

## Assumptions

- **The default verbosity for a test run suppresses routine records but not problems.** The description asked only that the output become readable. Suppressing everything would also achieve that, but it would hide a genuine service-side error that a failing test is trying to explain. The chosen default keeps failure records and drops routine ones. The values themselves are named in the plan, not here.
- **The test-run default is a default, not a lock.** It applies when nothing is supplied, and any explicitly supplied value wins. This is what makes FR-006 possible.
- **Deployed behaviour is unchanged.** The absent-setting default equals today's verbosity. A quieter production service is not in scope and would be an observability regression, not a fix.
- **The set of recognised values is the one the service's existing logging already understands**, rather than a new project-specific vocabulary. Inventing a parallel set of names would create a mapping layer for no benefit.
- **The setting is read once at startup.** Changing verbosity at runtime, without a restart, is out of scope: no user story requires it, and the service has no mechanism for reconfiguring a running process.
- **Per-component or per-route verbosity is out of scope.** One threshold for the process. Nothing in the reported problem needs finer granularity.
- **Routing records anywhere other than the console is out of scope.** Writing them to a file would also clear the CI console, but it leaves the volume, and the cost of producing it, in place.
- **The volume figure in SC-002 comes from the observed suite.** One integration scenario runs ten thousand trials, each issuing two requests, and each request produces one record.
- **The existing environment template-versus-schema parity gate stays as it is.** This feature satisfies that gate rather than relaxing it.
