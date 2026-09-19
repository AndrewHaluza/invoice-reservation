# Program Capacity & Invoice Reservation Constitution

## Core Principles

### I. Money Is Never Floating Point (NON-NEGOTIABLE)

All monetary amounts MUST be represented as integer minor units (e.g. cents) with an
explicit ISO-4217 currency code, persisted as `NUMERIC`/`BIGINT`, and never as
JavaScript `number` floats. Every amount crossing a boundary (HTTP, Kafka, DB) MUST
carry its currency. Cross-currency arithmetic is FORBIDDEN unless an explicit FX
conversion with a recorded rate, rate source, and rate timestamp is applied first.

Rationale: silent rounding or implicit currency coercion in a credit-limit ledger
produces unrecoverable financial error.

### II. Capacity Is a Ledger, Not a Counter

Available capacity MUST be derived from an append-only sequence of reservation and
release events, never from an in-place mutated balance that loses history. Every
state change MUST be attributable to an event with an id, actor, timestamp, and
reason. Corrections MUST be compensating entries; deleting or editing history is
FORBIDDEN. A program's reported position MUST at all times equal the sum of its ledger
entries — setting a position directly is FORBIDDEN, including when applying an external
reconciliation snapshot, which MUST be expressed as a compensating entry for the
difference. The ledger, together with the stream position it was applied through, is the
authoritative source for recovery; reconstructing a position by replaying the inbound
event stream from origin is FORBIDDEN.

Rationale: auditability and reconstructability are required to reconcile against an
external treasury system, and a position that can be set behind the ledger's back makes
the audit trail an unverifiable narrative rather than the arithmetic itself.

### III. Concurrency Safety Under Contention (NON-NEGOTIABLE)

Reservation, release, and cancellation MUST execute inside a database transaction that
serializes per-program access (row-level lock or equivalent). Read-modify-write of
capacity without such a lock is FORBIDDEN. Over-reservation MUST fail loudly with a typed
domain error, never clamp silently.

The invariant `locally_reserved <= totalCreditLimit` MUST be enforced in the database —
by a `CHECK`, a trigger, or an equivalent mechanism — and not by application code alone:
this service MUST NOT be capable of accepting a reservation that breaches the limit. The
enforcement MUST bind only the direction in which this service consumes capacity. A
mechanism that also rejects an externally asserted *reduction* of the limit is
non-compliant, because it refuses an assertion the next paragraph requires be recorded;
the limit falling below existing reservations is an over-limit condition to be marked,
never a write to be aborted. The total position, which includes externally
asserted state, MAY exceed the limit, because the external treasury system is the system
of record and its assertions MUST be recorded rather than rejected. When it does, the
program MUST be marked over-limit, all new reservations against it MUST be refused, and
operators MUST be alerted; the mark MUST clear automatically once the total returns
within the limit, and both onset and clearance MUST be recorded as ledger entries.

Rationale: concurrent approvals on the same program are the primary correctness risk, and
the constraint must bind precisely what this service controls. Enforcing it against
externally asserted state would force the service to discard the system of record's own
figures, trading a visible over-limit condition for a silent data loss.

### IV. Idempotency and Ordering for All Inbound Events

Every reservation, release, cancellation, and Kafka message MUST achieve exactly-once
effect under at-least-once delivery, keyed by a stable client-supplied or
message-supplied identifier. A repeat whose identifier AND outcome-determining content
both match MUST be a no-op returning the original outcome. A request reusing an
identifier with differing content MUST be refused as a typed conflict — replaying the
original outcome for it is FORBIDDEN, because the caller would hold a false belief about
what was reserved.

Duplicate suppression by identity MUST be applied before staleness evaluation. Bulk
reconciliation messages MUST carry a monotonic version or timestamp; stale messages MUST
be discarded, and a message whose version equals the applied state but whose content
differs MUST be quarantined rather than arbitrated. Poison messages MUST go to a
dead-letter path — silent drop is FORBIDDEN.

Rationale: Kafka guarantees at-least-once delivery and no global ordering, and a botched
client retry is the common case in which idempotency quietly moves money.

### V. Secure and Authenticated by Default (NON-NEGOTIABLE)

Every HTTP endpoint MUST require authentication; public access MUST be opt-in per
route and explicitly justified. Authorization MUST be enforced at the program scope,
not merely at the route: a credential identifies an owning organisation, and the set of
programs it may reach MUST be resolved from that organisation's current ownership rather
than embedded in the credential. Read access MUST be separable from the ability to move
capacity. A refusal MUST NOT reveal whether an out-of-scope program exists. Secrets MUST come from environment/secret manager and MUST
NEVER be committed. All request payloads MUST be validated by schema (`class-validator`
DTOs with a global `ValidationPipe`, `whitelist: true`) at the boundary. Error
responses MUST NOT leak internal state, stack traces, or other tenants' data.

Authentication is not limited to HTTP. Every inbound stream from which this service
accepts state MUST be authenticated at the transport layer and restricted so that only
the asserting system's own identity may publish to it. Schema validation establishes that
a message is well-formed, never that it is authentic; a stream that anyone reaching the
broker may write to is an unauthenticated write path into the ledger, and treating it as
trusted because it is internal is FORBIDDEN. Requests MUST be rate-limited per calling
organisation, so that one tenant cannot deny service to another.

Rationale: the message stream can move a program's entire position without any credential
being presented to this service. Leaving it outside the authentication principle put the
system's highest-value write path beyond its strongest rule.

### VI. Test-First with Concurrency and Failure Coverage (NON-NEGOTIABLE)

TDD is mandatory: failing test → minimal implementation → refactor. Minimum 80%
coverage. Beyond unit tests, the suite MUST include: an integration test proving
concurrent reservations cannot exceed the limit, an idempotency test replaying a
duplicate message, a stale-reconciliation test, and a currency-mismatch rejection
test. Merging on a red suite is FORBIDDEN.

### VII. Runnable Locally, Observable in Production

`docker compose up` plus a documented `.env.example` MUST bring up the service with
its dependencies (Postgres, Kafka) and seed data, verified from a clean clone. The
service MUST emit structured JSON logs with a correlation id propagated from HTTP and
Kafka headers, expose health/readiness endpoints, and expose metrics for reservation
outcomes and consumer lag. Every assumption or trade-off MUST be recorded in
`docs/ASSUMPTIONS.md` with its rationale.

## Technology & Security Constraints

- Runtime stack: **NestJS** (TypeScript, strict mode) — mandated by the project owner.
  `any` and non-null assertions require an inline justification comment.
- Persistence: PostgreSQL. Schema changes MUST ship as versioned, reversible migrations;
  hand-edited production schema is FORBIDDEN.
- Messaging: Kafka consumers MUST use manual offset commit after successful processing,
  and MUST be idempotent per Principle IV.
- Module boundaries: domain logic MUST NOT import HTTP, ORM, or Kafka types. Adapters
  depend on the domain, never the reverse.
- File organization: files 200–400 lines typical, 800 maximum; functions under 50 lines;
  nesting depth at most 4.
- Immutability: domain objects MUST be treated as immutable — operations return new
  values rather than mutating inputs.
- FX rates MUST be sourced from a single configured provider abstraction with a cached,
  timestamped rate; hardcoded rates outside tests are FORBIDDEN.

## Development Workflow & Quality Gates

1. Research and reuse before net-new code: check existing NestJS/Kafka patterns and
   published libraries before hand-rolling utilities.
2. Plan before implementing; break work into phases with explicit risks.
3. Implement test-first per Principle VI.
4. Run code review and security review before merge; CRITICAL and HIGH findings MUST be
   fixed, MEDIUM findings fixed or explicitly deferred with a recorded reason.
5. Merge gate — ALL of: build green, lint clean, tests green at ≥80% coverage,
   migrations apply and roll back cleanly, no hardcoded secrets, `docs/ASSUMPTIONS.md`
   current.
6. Commits follow `<type>: <description>` conventional format.

## Governance

This constitution supersedes conflicting practices and applies to all contributors and
agents working in this repository.

- **Amendments**: proposed as a pull request that edits this file, states the rationale,
  and lists affected artifacts. An amendment takes effect on merge.
- **Versioning**: semantic. MAJOR for removing or incompatibly redefining a principle;
  MINOR for adding a principle or materially expanding guidance; PATCH for
  clarifications and wording.
- **Compliance review**: every PR review MUST verify compliance with the principles
  above. Any deviation MUST be justified in the PR description and recorded in
  `docs/ASSUMPTIONS.md`; unjustified deviations block merge.
- **Complexity**: added complexity MUST be justified against a stated requirement;
  otherwise the simpler option wins.

**Version**: 2.1.0 | **Ratified**: 2026-09-19 | **Last Amended**: 2026-09-19
