# Feature Specification: End-to-End API Tests for Overbooking, Idempotency, Lock Contention and Access Control

**Feature Branch**: `004-e2e-api-tests`

**Created**: 2026-09-21

**Status**: Implemented — merged to `develop`; convergence tasks open in tasks.md

**Input**: User description: "Need to add e2e api tests; Overbooking, idempotency, deadlock, RBAC; Tooling: jest, supertests"

## Context: what already exists

This feature was specified against the repository as it stands on `develop`, not from a
blank slate. Three of the four named concerns already carry end-to-end coverage that boots
the real `AppModule` and drives it over HTTP with supertest:

| Concern | Existing end-to-end coverage |
|---|---|
| Idempotency | Replay returning `200` with an identical body; `409 IDEMPOTENCY_CONFLICT` on a reused key with different content; a key first used to reserve then reused to release; the missing-key `400`. Across reserve, release and cancellation. **Not covered over HTTP: the in-flight and expired refusals.** |
| Access control | Every non-public route answers `401` without a token, `403 INSUFFICIENT_SCOPE` for a scope-less token and for a token holding only other scopes, and serves with a fully-scoped token. A foreign program and a nonexistent program are indistinguishable (`404`, never `403`). |
| Overbooking | 1,000 concurrent reservations against capacity for 100 yield exactly 100 acceptances; the rest refuse with `INSUFFICIENT_CAPACITY` and none fails on contention. |
| Lock contention | Covered only **below** the API, at the repository and unit-of-work level. |

**This feature therefore does not re-specify that coverage.** Duplicating it would add run
time and maintenance weight while proving nothing new. What follows is scoped to the gaps
that survive that audit, and the gaps are real: one refusal reachable only in production,
a deterministic overbooking boundary that is only ever observed through a thousand-request
storm, and a contention class asserted nowhere above the repository.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Every reachable capacity refusal is observed through the API (Priority: P1)

An engineer changing reservation or release logic needs to know that each way the system
can refuse a write still reaches the caller as the documented status and code. The system
defines fourteen refusal codes. Nine are observed through an HTTP response somewhere in
the suite today. **Five are not**, and four of those five are reachable through ordinary
requests: the refusal raised when a program is beyond its credit limit, the one raised
when an invoice is reserved twice, the one raised while an identical request is still
being applied, and the one raised when a replayed key has aged out of retention. Each is
asserted today only at service level, or only against a hand-constructed error object.

**Why this priority**: these are the refusals a caller will actually meet, and none has
end-to-end evidence. A regression in how any of them surfaces would reach production
undetected. The over-limit refusal is the most serious of the four, because it is the
control that stops a financing program from overbooking once the external system of
record has moved its position.

**Independent Test**: reach each refusal through the supported path, issue the request,
and assert the response status, code and body shape. Delivers proof that every refusal a
caller can provoke is wired end to end.

**Acceptance Scenarios**:

1. **Given** a program whose total position exceeds its credit limit, **When** a caller
   with write authority requests a reservation against it, **Then** the response carries
   the over-limit refusal code, the status the error contract assigns to it, and no
   reservation is recorded.
2. **Given** a program restored to within its limit, **When** the same reservation is
   retried, **Then** it succeeds, proving the refusal is a function of position and not a
   sticky state.
3. **Given** an invoice already reserved against a program, **When** the same invoice
   identifier is reserved again under a different idempotency key, **Then** the response
   carries the duplicate-invoice refusal and nothing further is recorded.
4. **Given** a request recorded as still in flight under an idempotency key, **When** the
   same key is presented again, **Then** the response carries the in-flight refusal rather
   than either replaying an outcome that does not yet exist or applying the write twice.
5. **Given** an idempotency record that has aged beyond retention, **When** its key is
   presented again, **Then** the response carries the expired refusal, distinct from both
   a successful replay and a content conflict.
6. **Given** any of these refusals, **When** the response body is read, **Then** it
   contains no stack trace, no SQL and no query text at any depth.

---

### User Story 2 - The overbooking boundary is proven deterministically (Priority: P1)

The suite proves that capacity is not oversold under a storm of a thousand simultaneous
requests. It does not prove the ordinary, deterministic case: that a single request for
one unit more than remains is refused, that a request for exactly what remains succeeds,
and that the boundary between them sits where the ledger says it does.

**Why this priority**: the storm test is slow, expensive and answers a concurrency
question. A boundary that is wrong by one unit passes it, because the storm's arithmetic
is dominated by contention rather than by the comparison at the edge. The off-by-one is
the failure a reviewer most needs caught, and it is caught fastest by a deterministic
sequential test.

**Independent Test**: against a program with known remaining capacity, issue single
requests at the boundary and one unit either side of it. Delivers an exact statement of
where the system stops accepting.

**Acceptance Scenarios**:

1. **Given** a program with a known remaining capacity, **When** a caller reserves exactly
   that amount, **Then** the reservation is accepted and the reflected availability reports
   nothing remaining.
2. **Given** that same program before the reservation, **When** a caller reserves one minor
   unit more than remains, **Then** the request is refused for insufficient capacity, and
   the recorded position is unchanged.
3. **Given** a program with nothing remaining, **When** a caller releases part of a prior
   reservation and then reserves the released amount, **Then** the reservation succeeds,
   proving released capacity re-enters the boundary calculation.

---

### User Story 3 - Contention on one program never surfaces as a failure (Priority: P2)

Two callers writing to the same program at the same moment contend for the same row lock.
The system's stated guarantee is that contention alone never produces a caller-visible
failure: one request waits, both complete, neither sees a server error or a serialization
failure. That guarantee is asserted today only against the repository and the unit of
work, never against the API.

**Why this priority**: it protects a guarantee the project has already written down, and
it closes the only one of the four named concerns with no end-to-end coverage whatsoever.
It ranks below the first two because the underlying locking is already directly tested
one layer down, so the residual risk is in the wiring rather than in the mechanism.

**Independent Test**: issue a small number of genuinely simultaneous writes against a
single program with capacity for all of them, and assert every response and the final
recorded position. Delivers evidence that the lock discipline holds through the full
request pipeline.

**Acceptance Scenarios**:

1. **Given** a program with capacity for several reservations, **When** those reservations
   are issued simultaneously by the same organisation, **Then** every one is accepted, no
   response is a server error, and no response reports a contention or serialization
   failure.
2. **Given** those completed writes, **When** the resulting position is read, **Then** it
   equals the sum of the accepted reservations exactly — no write is lost and none is
   double-counted.
3. **Given** simultaneous writes of different kinds against one program — a reservation, a
   release of an earlier reservation and a cancellation of another — **When** all are
   issued at once, **Then** each is accepted or refused on its own merits and none fails
   for contention.

---

### Edge Cases

- **One refusal is unreachable because the boundary validator is stricter than the domain
  guard.** The release policy refuses a non-positive release amount, but the request body
  is validated first against a pattern that admits only strictly positive integer strings,
  so the domain guard is never reached from an HTTP request. The suite records this as
  unreachable rather than contriving a way past validation. The interactive documentation
  currently lists that refusal among the possible `400` responses for three operations,
  which overstates what a caller can observe; correcting it is a documentation change
  outside this feature's scope, and FR-010 forbids touching production code here.
- **A deliberate multi-program deadlock cannot be provoked through the API.** The system
  locks exactly one program per transaction today, and no endpoint accepts more than one
  program. A genuine deadlock needs two transactions taking two programs in opposite
  orders, which no supported request can express. The suite therefore asserts the
  guarantee that is reachable — single-program contention never surfaces as a failure —
  and does not simulate a deadlock the API cannot cause. This is recorded, not silently
  dropped; see Assumptions.
- What happens when the boundary request and the release that frees the capacity arrive in
  the same instant? Treated as ordinary contention, covered by User Story 3, and the
  outcome is decided by whichever transaction takes the lock first; the test asserts that
  both complete without error, not which wins.
- What happens when a test's program is left over limit by a failed assertion? Each
  scenario must establish its own program state and must not depend on state left by an
  earlier scenario, so a failure cannot cascade into false failures downstream.
- What happens when the suite runs with no container runtime available? It must fail with
  a clear statement of the missing prerequisite rather than a timeout or an obscure
  connection error.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The suite MUST exercise the assembled application over HTTP, through the same
  request pipeline a real caller reaches — validation, authentication, authorisation, rate
  limiting and error translation all in force. **Every assertion MUST come from an HTTP
  response or from reading the resulting database row.** No scenario may assert against a
  service, repository or policy return value.
- **FR-001a**: Establishing a precondition through an inbound handler is permitted **only**
  where no HTTP route can reach the required state, and the scenario MUST then assert that
  the precondition holds before issuing its request. Exactly one state qualifies today: a
  program whose total position exceeds its credit limit, which no sequence of requests can
  produce because the database constrains locally reserved capacity to the limit (R-001).
  A precondition that a route *can* establish MUST be established through that route.
- **FR-002**: The suite MUST assert, end to end, each refusal that is reachable through an
  ordinary request and not already observed over HTTP — over-limit, duplicate invoice,
  request in flight, and idempotency expired — checking the status, the code and the
  absence of any unintended write.
- **FR-003**: The suite MUST assert the capacity boundary at exactly the remaining amount,
  at one minor unit above it, and after capacity is returned by a release.
- **FR-004**: The suite MUST assert that simultaneous writes against a single program all
  complete without a server error and without a contention or serialization failure, and
  that the resulting position equals the sum of the accepted writes.
- **FR-005**: The suite MUST assert the final recorded position after every scenario that
  writes, not merely the response body. A correct response over a wrong ledger is a defect.
- **FR-006**: No response body asserted by the suite may contain a stack trace, SQL text or
  query text at any depth.
- **FR-007**: Every scenario MUST establish the state it depends on and MUST NOT depend on
  state left behind by any other scenario, in the same file or another.
- **FR-008**: The suite MUST be runnable by a single command, separately from the existing
  test commands, and that command MUST be documented wherever the project already documents
  how to run its tests — a script entry alone does not satisfy "documented".
- **FR-009**: The suite MUST NOT modify, weaken, skip or delete any existing test.
- **FR-010**: The suite MUST NOT change any production behaviour. No source file outside
  the test tree and its own configuration may change to accommodate it.
- **FR-011**: Every existing command — the full test run, the unit run, the coverage run
  with its global threshold, the type check, the lint, the build, the documentation gate
  and the mutation gate — MUST behave exactly as before.
- **FR-012**: The suite MUST NOT duplicate a scenario already asserted end to end by an
  existing test. Where a scenario extends an existing one, the extension MUST be the only
  new assertion.
- **FR-013**: A scenario the API cannot reach MUST be recorded as unreachable with its
  reason, and MUST NOT be simulated below the API and presented as end-to-end evidence.
- **FR-014**: The suite MUST run in the existing automated checks, and MUST NOT alter the
  behaviour, triggers or reported results of any existing automated check.
- **FR-015**: The suite MUST import only from a module's public entry point, from
  `test/support/`, and from the seeded constants the existing tests use. It MUST NOT reach
  into a layer's internals to shortcut a scenario.

  > **This one cannot be delegated to the linter.** `eslint.config.mjs` sets
  > `'boundaries/include': ['src/**/*.ts']`, so eslint-plugin-boundaries never evaluates a
  > file under `test/` and `npm run lint` will pass whatever the suite imports. An earlier
  > revision of this requirement said only "no cross-layer import the boundary rules
  > forbid", which was unverifiable for exactly that reason. Verification is by inspection
  > of the new files' import lists.
- **FR-016**: A failure MUST identify which scenario failed, the expected and actual
  status, and the response code, without requiring the reader to re-run under a debugger.

### Key Entities

- **Program**: the unit capacity is measured against. Carries a credit limit, a recorded
  reserved position and a currency. Owned by exactly one organisation.
- **Reservation**: a caller's claim on part of a program's capacity. Has an amount in minor
  units, a state, and an owning invoice.
- **Caller credential**: identifies an organisation and carries the authority a route
  requires. Determines both what a caller may do and which programs it can see at all.
- **Idempotency key**: the caller-supplied identifier that makes a repeated write safe.
  Scoped to an organisation and bound to the content of the request that first used it.
- **Recorded position**: the append-only account of what a program has committed. The
  authority against which every response is checked.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every refusal code reachable through an ordinary request is observed at least
  once through an HTTP response: 13 of the 14 defined codes, up from 9 today. The
  fourteenth is unreachable by construction and is recorded as such rather than counted
  as a gap.
- **SC-002**: The capacity boundary is proven by deterministic single requests completing
  in under 30 seconds in total **excluding container start-up**, without relying on the
  existing thousand-request storm.
- **SC-003**: Simultaneous writes against one program produce zero server errors and zero
  contention failures across every run, and the resulting position matches the accepted
  writes exactly.
- **SC-004**: The whole new suite completes in under 5 minutes on the automated runner.
- **SC-005**: Every pre-existing check reports the same result, in the same way, as it did
  before the feature — verified by comparing a run before and after.
- **SC-006**: A reviewer can name, from the suite alone and without reading source, both
  unreachable cases — the multi-program deadlock and the non-positive release amount — and
  why each is unreachable.
- **SC-007**: Zero scenarios duplicate an assertion an existing end-to-end test already
  makes.
- **SC-008**: A deliberately introduced off-by-one in the capacity comparison causes the
  suite to fail — verified once, on a throwaway copy that is never committed.

## Assumptions

- The four concerns named in the request were audited against the existing suite before
  specification. Idempotency and access control were found already covered end to end and
  are therefore **out of scope** except where an existing scenario is extended. Recording
  this rather than re-specifying them is a deliberate choice; the alternative was a
  duplicate suite that lengthens every run and proves nothing new.
- "Deadlock" is interpreted as the contention guarantee the project already states: two
  transactions meeting on the same program must not produce a caller-visible failure. A
  true multi-program deadlock is unreachable through the API today, because one program is
  locked per transaction and no endpoint accepts more than one. Should a multi-program
  endpoint ever be added, deadlock coverage becomes owed at that moment, and this
  assumption is the record of that debt.
- The suite lives in its own directory alongside the existing test directories and is
  addressed by its own command, following the pattern already used for the recovery and
  performance suites.
- The suite depends on a container runtime, like the existing integration and contract
  suites. It is not expected to run without one, and it is excluded from the container-free
  unit run.
- Seeded organisations and programs are reused where they fit; scenarios needing a specific
  position establish it themselves rather than assuming a seed value.
- The over-limit condition is reached through the supported path that sets it, not by
  writing the flag directly, so the test proves the production route rather than a fixture.
- The tooling is the one already in the repository — the existing test runner and HTTP
  assertion library, at the versions already installed. No new dependency is expected.
