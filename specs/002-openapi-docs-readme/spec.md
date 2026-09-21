# Feature Specification: API Documentation & Project README

**Feature Branch**: `002-openapi-docs-readme`

**Created**: 2026-09-21

**Status**: Implemented — merged to `develop`; convergence tasks open in tasks.md

**Input**: User description: "docummentation (openapi) to be able see API documentation in swagger, import into API client; missing readme"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Browse the API in an interactive reference (Priority: P1)

An integrator who has been given access to a running instance of the service opens a
documentation page in a browser and sees every operation the service exposes: what each
one does, which path and parameters it takes, what the request body must contain, which
permission it requires, and every response it can return — including the refusal and
error shapes. They read it without asking anyone for a Postman collection, a wiki page,
or a walkthrough, and without reading source code.

**Why this priority**: This is the whole point of the request and the only item that
delivers value entirely on its own. An integrator today has no way to learn the surface
of the service except by reading TypeScript controllers, which non-owners cannot be
expected to do. Everything else in this feature is a distribution channel for the same
underlying description.

**Independent Test**: Start the service, open the documentation page, and confirm that a
reader who has never seen the codebase can name every operation, its required permission,
its request body fields, and its success and failure responses — using only that page.

**Acceptance Scenarios**:

1. **Given** a running instance, **When** an integrator opens the documentation page,
   **Then** every operation the service exposes is listed, grouped by area, each with a
   summary describing what it does in business terms.
2. **Given** the documentation page is open, **When** the integrator inspects a
   capacity-moving operation, **Then** the page states that a caller-supplied
   idempotency identifier is required, its length limits, and what happens when the same
   identifier is replayed with identical versus differing content.
3. **Given** the documentation page is open, **When** the integrator inspects any
   operation, **Then** the page states the permission the caller's credential must carry
   and shows the shape of the error response returned when it does not.
4. **Given** the documentation page is open, **When** the integrator inspects a monetary
   field, **Then** the page states that the amount is an integer string in minor units
   accompanied by an explicit currency code, with an example.
5. **Given** the documentation page is open, **When** the integrator supplies a
   credential and invokes an operation from the page, **Then** the service responds as it
   would to any other client and the response is displayed.

---

### User Story 2 - Import the API into an API client (Priority: P2)

An integrator retrieves a single machine-readable description of the API and imports it
into their own tool — an API client such as Postman or Insomnia, a code generator, or a
contract-testing harness — producing working, pre-filled requests without hand-typing
paths, headers, or body fields.

**Why this priority**: Depends on the same description as P1 but adds distribution.
Valuable, and the explicit second half of the request, but an integrator who has P1 can
already work; without P1 an importable file describes nothing anyone has agreed on.

**Independent Test**: Fetch the description from a running instance, import it into at
least two different API clients, and confirm each produces an executable request per
operation that succeeds against a seeded instance once a credential is supplied.

**Acceptance Scenarios**:

1. **Given** a running instance, **When** the integrator retrieves the machine-readable
   API description, **Then** it is returned as a single self-contained document in a
   widely supported standard format and version.
2. **Given** the downloaded description, **When** it is imported into a mainstream API
   client, **Then** the import completes without errors and every operation appears as a
   runnable request with its path, parameters, headers, and an example body.
3. **Given** an imported request, **When** the integrator sets the credential once at the
   collection level, **Then** every authenticated request inherits it rather than
   requiring per-request configuration.
4. **Given** the description, **When** it is checked by a standard schema validator for
   the chosen format, **Then** it reports no errors.
5. **Given** the service's set of operations changes, **When** the description is
   retrieved again, **Then** it reflects the change without anyone having edited a
   separate document by hand.

---

### User Story 3 - Get the service running from a clean clone (Priority: P3)

A developer joining the project clones the repository, opens the README, and follows it
end to end: prerequisites, one command to bring up the service and its dependencies, how
to obtain a working credential and sample identifiers, how to make a first successful
call, how to run the tests, and where the deeper documents live. They reach a successful
API call without asking a teammate a question.

**Why this priority**: Real and currently missing — there is no README at all — but it
serves contributors rather than API consumers, and the project already has working
tooling that the README describes rather than creates.

**Independent Test**: On a machine with only the stated prerequisites, clone the
repository fresh and follow the README literally, with no other source of information,
until a first API call returns a success response and the test suite runs.

**Acceptance Scenarios**:

1. **Given** a clean clone and the stated prerequisites, **When** the developer follows
   the README's startup section, **Then** the service and its dependencies come up and a
   readiness check reports healthy.
2. **Given** the service is up, **When** the developer follows the README's first-call
   walkthrough, **Then** they obtain a credential and sample identifiers from the
   documented output and receive a success response from a real operation.
3. **Given** the README, **When** a developer looks for how to run the tests, how the
   layered structure is organised, or where the interactive API documentation is,
   **Then** each is stated or linked, and every link resolves.
4. **Given** the README, **When** a reviewer scans it for credentials, **Then** it
   contains no secret values, only references to where local development values come
   from.
5. **Given** the README's environment section, **When** a developer compares it to what
   the service actually requires at startup, **Then** the two agree.

---

### Edge Cases

- **Documentation page reachable without a credential.** The page itself describes the
  contract and is not tenant data; it must be openly readable in local and non-production
  environments. Whether it is exposed in production is a deployment decision that must be
  controllable without a code change, and it must be possible to turn it off entirely.
- **Invoking an operation from the page without a credential.** The attempt must be
  refused by the same authentication the service applies to any client — the page is a
  convenience, never a bypass.
- **A reader inspecting a program they do not own.** Documented refusal responses must
  not disclose whether an out-of-scope program exists; documented examples must not
  imply otherwise.
- **The description drifting from the running service.** A documented operation that no
  longer exists, or an operation absent from the description, is a defect. The
  description is generated from what the service actually serves, and a check fails when
  a hand-maintained artefact contradicts it.
- **Very large monetary values.** Amounts beyond the range a reader's tooling handles as
  a native number must be documented as strings, and examples must show them as such, so
  an imported client does not silently corrupt them.
- **A replayed idempotency identifier.** Both outcomes — identical content returning the
  original result, and differing content being refused as a conflict — must be
  documented as distinct responses of the same operation.
- **Documentation page requested when disabled.** The request must be refused cleanly,
  disclosing nothing about whether the feature exists.
- **README describing a command that no longer exists.** Commands and environment
  variables quoted in the README are verifiable against the repository, and a mismatch is
  a defect.

## Requirements *(mandatory)*

### Functional Requirements

#### Machine-readable API description

- **FR-001**: The service MUST publish a machine-readable description of its complete
  HTTP surface in a widely adopted, tool-neutral standard format, retrievable as a single
  self-contained document from a running instance.
- **FR-002**: The description MUST be derived from the operations the service actually
  serves, so that adding, removing, or changing an operation is reflected without a
  separate document being edited by hand.
- **FR-003**: The description MUST validate cleanly against the published schema for its
  format and version.
- **FR-004**: The description MUST cover, for every operation: the path and method, every
  path and query parameter with its type and constraints, every required header, the
  request body schema with field-level constraints, and every response the operation can
  return with its status and body schema.
- **FR-005**: The description MUST document the error response shape used across the
  service, including its machine-readable code, human-readable message, and per-field
  detail, and MUST associate it with each operation that can return it.
- **FR-006**: The description MUST express the authentication mechanism and, per
  operation, the permission a caller's credential must carry.
- **FR-007**: The description MUST represent monetary amounts as integer strings in minor
  units paired with an explicit currency code, and MUST NOT represent any monetary
  amount as a floating-point or native numeric type.
- **FR-008**: The description MUST include a realistic example request and response for
  every operation, using identifiers consistent with the project's seeded sample data.
- **FR-009**: The description MUST carry service-level metadata: a title, a version, a
  description of the service's purpose, and a server entry that resolves against a
  locally running instance.
- **FR-010**: Health and readiness endpoints MUST be included and marked as requiring no
  credential.

#### Interactive documentation page

- **FR-011**: The service MUST serve a human-browsable, interactive documentation page
  rendered from the machine-readable description, at a stable, documented path.
- **FR-012**: The page MUST let a reader supply a credential once and invoke any operation
  against the running instance, with the response displayed.
- **FR-013**: Operations MUST be grouped into named areas so that the page is navigable
  without prior knowledge of the service's internal structure.
- **FR-014**: Every operation on the page MUST carry a summary stated in business terms,
  not a restatement of its path.
- **FR-015**: Exposure of the documentation page and the description endpoint MUST be
  controllable by configuration, defaulting to enabled outside production, and MUST be
  fully disableable without a code change.
- **FR-016**: Invoking an operation from the page MUST be subject to the same
  authentication, authorisation, validation, and rate limiting as any other client; the
  page MUST NOT create a privileged path.

#### Documented behaviours

- **FR-017**: The documentation MUST state, for every capacity-moving operation, that a
  caller-supplied idempotency identifier is required, its permitted length, that a replay
  with matching content returns the original outcome, and that a replay with differing
  content is refused as a conflict.
- **FR-018**: The documentation MUST state the rate limits applied per calling
  organisation and the response returned when a limit is exceeded.
- **FR-019**: The documentation MUST state the pagination contract for every operation
  that returns a collection.
- **FR-020**: Documented refusals MUST NOT disclose the existence of resources outside the
  caller's scope, and examples MUST NOT contradict this.

#### README

- **FR-021**: The repository MUST contain a README at its root that states what the
  service does and the business problem it solves, in terms a reader outside the team can
  follow.
- **FR-022**: The README MUST state the prerequisites required to run the project and the
  single command that brings up the service with its dependencies, migrations, and seed
  data from a clean clone.
- **FR-023**: The README MUST provide a first-call walkthrough: how to obtain a working
  credential and sample identifiers from the startup output, and a complete example
  request that returns a success response.
- **FR-024**: The README MUST link to the interactive documentation page and the
  machine-readable description, with the paths at which each is served.
- **FR-025**: The README MUST state how to run each test suite and how coverage is
  verified.
- **FR-026**: The README MUST describe the project's layered structure and state that
  cross-layer dependencies are enforced automatically rather than by convention.
- **FR-027**: The README MUST describe how configuration is supplied and validated, and
  MUST point to the example configuration file rather than restating its values.
- **FR-028**: The README MUST link to the deeper documents that already exist — the
  project's governing principles, its recorded assumptions and trade-offs, and its
  planning artefacts.
- **FR-029**: The README MUST NOT contain any secret value.
- **FR-030**: Every command, path, and configuration name quoted in the README MUST exist
  in the repository, and every link MUST resolve.

#### Keeping documentation true

- **FR-031**: An automated check MUST fail when the machine-readable description no longer
  matches the operations the service serves.
- **FR-032**: An automated check MUST fail when the description does not validate against
  its format's schema.
- **FR-033**: An automated check MUST fail when a command, path, or configuration name
  quoted in the README does not exist in the repository.

### Key Entities

- **API description document**: The single machine-readable artefact describing the
  service's entire HTTP surface — its operations, their inputs, their outputs, its error
  shape, and its authentication and permission model. Generated from the running service,
  never hand-authored.
- **Operation**: One callable action on the API — its path, method, parameters, required
  headers, request body, permitted responses, required permission, and grouping area.
- **Error shape**: The response body returned on every refusal — a machine-readable code,
  a human-readable message, and optional per-field details. Shared across all operations.
- **Documentation area**: A named grouping of operations, used to make the page navigable
  (for example: reservations, availability, audit, health).
- **README**: The repository's entry document — purpose, prerequisites, startup,
  first call, tests, structure, configuration, and links onward.
- **Seeded sample data**: The organisations, programs, and credentials the project's seed
  step creates; documentation examples draw their identifiers from these so that a reader
  can run them unmodified.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An integrator who has never seen the codebase can list every operation, its
  required permission, its request fields, and its possible responses using only the
  documentation page — verified with at least two readers, with no reference to source
  code.
- **SC-002**: 100% of the operations the service serves appear in the description, and
  100% of the operations in the description are served — zero drift in either direction.
- **SC-003**: The description imports without error into at least two mainstream API
  clients, and every imported request executes successfully against a seeded instance
  once a credential is supplied, with no hand-editing of any request.
- **SC-004**: The description passes a standard schema validator for its format with zero
  errors and zero warnings that indicate missing required metadata.
- **SC-005**: A developer with only the stated prerequisites, starting from a clean clone
  and using only the README, reaches a successful API call in under 15 minutes without
  asking anyone a question — verified with at least two developers.
- **SC-006**: 100% of commands, paths, and configuration names quoted in the README exist
  in the repository, and 100% of its links resolve — enforced by an automated check that
  fails the build otherwise.
- **SC-007**: Every operation carries a business-language summary and at least one
  complete request and response example; zero operations are documented by path alone.
- **SC-008**: Zero monetary fields in the description are typed as a floating-point or
  native numeric value.
- **SC-009**: With documentation exposure disabled by configuration, neither the page nor
  the description is retrievable, and the refusal discloses nothing about the feature's
  existence.
- **SC-010**: Requests issued from the documentation page without a valid credential are
  refused at the same rate as equivalent requests from any other client — the page grants
  no additional access.

## Assumptions

- **The API surface is the existing one.** This feature documents what the service
  already serves and adds no operation, field, or behaviour. Any behavioural gap the
  documentation work exposes is raised separately, not fixed here.
- **OpenAPI is the format.** It is the standard both mainstream API clients and the
  request's own wording ("swagger") assume, and no other format was named. A recent
  3.x version is used.
- **The description is generated, not hand-written.** The project's stated principle is
  that documentation must stay true to the running service; a hand-maintained file drifts
  by default. Generation is therefore treated as a requirement, not an implementation
  choice.
- **Exposure defaults to on locally, and is configurable.** Publishing an API contract is
  not disclosing tenant data, so it is open in development. Whether a production
  deployment exposes it is a deployment decision, so it is configuration-driven with an
  off switch.
- **Examples use the seeded sample data.** The project already seeds organisations,
  programs, and credentials at startup, so examples that reference them are runnable as
  written.
- **The README targets developers and integrators**, not operators. Deployment,
  monitoring, and on-call runbooks are out of scope.
- **No hosted or published documentation site.** The page is served by the service itself;
  publishing to an external portal, versioning across releases, or hosting a public
  catalogue is out of scope.
- **No client SDK generation.** The description makes generation possible for consumers;
  producing and maintaining SDKs is not part of this feature.
- **The stream interface is out of scope.** This feature covers the HTTP surface. The
  message-stream contract the service consumes is documented separately if at all.
- **Existing documents are linked, not replaced.** The governing principles, recorded
  assumptions, and planning artefacts stay where they are; the README points to them.
