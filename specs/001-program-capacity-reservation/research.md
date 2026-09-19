# Phase 0 Research: Program Capacity & Invoice Reservation

**Date**: 2026-09-19 | **Plan**: [plan.md](./plan.md)

No `NEEDS CLARIFICATION` markers survived into Technical Context — the two `/speckit-clarify`
sessions resolved the open questions at spec level. This document records the technical decisions
that fill it in, each against the constraint that forced it.

---

## R1. Concurrency control for the reservation write path

**Decision**: Pessimistic row lock — `SELECT … FROM program WHERE id = $1 FOR UPDATE` at the head
of every reservation, release, cancellation, and snapshot transaction, at `READ COMMITTED`.

**Rationale**: Constitution III mandates a lock that serializes per-program access, and SC-001
requires that 1,000 concurrent attempts never over-reserve across 20 consecutive runs. A row lock
gives that deterministically: contending transactions queue rather than fail. It also makes the
read-modify-write of the derived position cache safe, which optimistic approaches do not without
retry loops that would show up as user-visible failures under SC-003a ("no request failing due to
contention alone").

**Alternatives considered**:
- *Optimistic concurrency with a version column and retry.* Higher throughput when contention is
  rare, but our worst case is exactly the contended one, and bounded retries eventually surface as
  errors — a direct SC-003a violation.
- *`SERIALIZABLE` isolation.* Correct, but converts contention into serialization failures the
  application must retry, with the same problem, plus a much wider blast radius across unrelated
  queries.
- *Advisory locks (`pg_advisory_xact_lock`).* Equivalent serialization without touching the row,
  but the lock then has no relationship to the data, and a stray query path can bypass it. Locking
  the row we are about to modify keeps the guarantee where the data is.

**Consequence for tests**: `concurrency.spec.ts` drives real parallel transactions through
Testcontainers, not mocks — a mocked repository cannot demonstrate this property.

---

## R2. Enforcing the capacity invariant in the database

**Decision**: `CHECK (… >= 0)` on each component column, plus a **`BEFORE UPDATE` trigger**
enforcing `local_reserved_minor <= credit_limit_minor` **only when `local_reserved_minor`
increases**. No constraint binds the *total*.

**Rationale**: Constitution III v2.0.0 scopes the mandatory constraint to locally-originated
reservations precisely so that a treasury-asserted over-limit position can be recorded rather than
rejected. Splitting reserved into two columns is what makes that expressible as a constraint at
all — with a single blended counter the constraint would have to be dropped entirely, and the
guarantee that *this service* cannot over-reserve would exist only in application code.

**Alternatives considered**:
- *Single `reserved_minor` column, constraint dropped.* Simplest schema; loses the structural
  guarantee and makes double-counting — a treasury event echoing a reservation we originated —
  undetectable. Echo detection itself is a separate mechanism (FR-010a, `reservationReference`);
  the split is what lets the two components be compared at all.
- *Plain `CHECK (local_reserved_minor <= credit_limit_minor)`.* This was the original decision and
  it is wrong. The predicate binds *both* operands, so a treasury-asserted **limit reduction**
  below our existing reservations aborts the `LIMIT_CHANGED` transaction — the limit is never
  lowered, and the service keeps lending against a facility that no longer exists. That rejects an
  assertion from the system of record, which Constitution III's own rationale forbids. The trigger
  is scoped to the direction the rule is actually about: this service must not consume capacity it
  does not have. A limit cut is recorded, and the program goes over-limit (FR-023).
- *Application-only enforcement.* Constitution III requires a database-level guarantee; a trigger
  is one. The domain policy remains the primary gate and is unit-tested; the trigger is the
  backstop that survives a bug in it.

---

## R3. Position storage: derived cache alongside an append-only ledger

**Decision**: `capacity_ledger_entry` is the authority, append-only, with `UPDATE` and `DELETE`
revoked from the application role. `program.local_reserved_minor` and
`program.treasury_reserved_minor` are a derived cache, advanced only inside the same transaction
that appends the entry, under the row lock from R1.

**Rationale**: Constitution II requires the position be derived and never set; SC-003 requires
sub-second reads. Deriving by aggregating the full ledger on every read cannot meet that as the
ledger grows. The cache resolves the tension without weakening the guarantee, because it is never
written except alongside its entry — so `SUM(ledger) = cached position` is an invariant an audit
job can assert (SC-004) and `FR-019b` requires it to be checked continuously.

**Alternatives considered**:
- *Pure derivation on read.* Purest form of Constitution II; fails SC-003 at any realistic ledger
  size.
- *Materialized view refreshed periodically.* Introduces a staleness window on the read path that
  directly contradicts FR-007b (read-your-writes).
- *Periodic checkpoint rows to bound replay.* Rejected because they give up single-pass
  reconstruction from origin, which Constitution II names as the recovery source.

---

## R4. Kafka consumption, ordering and exactly-once effect

**Decision**: KafkaJS with `eachMessage`, **manual offset commit after the handling transaction
commits**, `autoCommit: false`. Messages keyed by program id, so a partition carries one program's
events in order. Duplicate suppression via a `processed_message` table written in the *same*
transaction as the ledger entry.

**Rationale**: Constitution IV requires exactly-once *effect* under at-least-once delivery. That is
unachievable with offset commits alone; it is achievable by making "the effect" and "the record
that this message was applied" the same atomic commit. Committing the offset only after that
transaction means a crash replays the message, and the `processed_message` row makes the replay a
no-op.

**Staleness applies to snapshots, never to deltas.** Version comparison makes *absolute state*
order-insensitive: replaying an older full state is safely discardable because a newer one already
supersedes it. An *incremental* event is different — it must apply exactly once regardless of
arrival order. Discarding a delta for being "older" than the applied snapshot version loses
capacity permanently, with no DLQ entry and no alert, which is a designed-in violation of SC-009's
0% silent loss. Incremental events are therefore deduplicated **by message identity only**
(FR-012a), and `program.treasury_version` tracks snapshot versions alone.

**Alternatives considered**:
- *Kafka transactions / EOS.* Provides exactly-once between Kafka topics; our sink is Postgres, so
  it solves the wrong half of the problem.
- *`autoCommit: true`.* Loses messages on crash between commit and handling — a silent capacity
  drift, which FR-014 forbids.
- *Dedupe by offset rather than message id.* Breaks if the producer republishes or partitions are
  reassigned; message identity is the stable key the spec assumes.

**Ordering caveat carried forward**: per-program ordering depends on the treasury producer keying
by program id, which is unratified — a question for the treasury team. Until answered the consumer
must not *rely* on ordering for correctness. With deltas now identity-deduplicated and snapshots
version-compared, out-of-order delivery is safe either way; only throughput depends on the key.

**Transient failures are retried, not quarantined.** A handler failure is classified before it
reaches the DLQ: connection loss, pool exhaustion, lock timeout and serialization failure are
transient and retried in-process with bounded exponential backoff, **without committing the
offset**. Only a message that can never apply is quarantined. Without this split, a 30-second
database failover republishes every in-flight message to the DLQ and commits its offset, drifting
every position silently while the consumer reports zero lag.

---

## R5. Snapshot application as a compensating entry

**Decision**: The snapshot's `reservedMinor` is **inclusive** of the local reservations it
acknowledges. The acknowledgement marker is applied **first**, then the correction is computed and
appended **per component**, inside the program row lock:

```text
target_treasury = snapshot.reservedMinor − Σ acknowledged local outstanding
target_local    = Σ all local outstanding
delta_treasury  = target_treasury − treasury_reserved_minor
delta_local     = target_local    − local_reserved_minor
delta_limit     = snapshot.creditLimitMinor − credit_limit_minor
```

Each non-zero delta becomes its own `RECONCILIATION_ADJUSTMENT` entry against its own component;
zero deltas append nothing and only the applied-version marker advances.

**Rationale**: Expressing the correction as arithmetic on the ledger is what keeps SC-004 true.
Two properties matter and neither is accidental:

*Inclusive, not exclusive.* If the snapshot excluded reservations it had acknowledged, those
reservations would appear in neither term — they would vanish from the position the instant
treasury confirmed them, recreating the phantom-capacity failure on the far side of the
acknowledgement boundary. Inclusivity is also the only reading under which an acknowledgement
marker means anything at all.

*Decomposed, not blended.* A single delta against the `TREASURY` component unrolls to
`snapshot.reserved + unacked_local − local_reserved`, which goes **negative** whenever the snapshot
acknowledges our reservations — aborting on `CHECK (treasury_reserved_minor >= 0)`, sending the
snapshot to the DLQ, and doing the same for every subsequent snapshot, leaving the program
permanently unreconcilable while SC-006 reports green because nothing ever "applies". Decomposed,
`target_treasury` reduces to treasury's own booked total and is non-negative by construction.

Decomposition also keeps blame attributable: `delta_local ≠ 0` means our own cache disagrees with
our own reservations — a local defect, which sets `investigation_required` (FR-019b) rather than
being silently absorbed into the treasury column.

**Ordering is specified, not left to the handler.** Marker first, then sums. The two orderings
differ by exactly the newly-acknowledged amount — the entire quantity in dispute.

**Magnitude guard**: a snapshot implying `|delta_treasury|` above half the credit limit is
quarantined as `IMPLAUSIBLE_DELTA` for operator review rather than auto-applied (FR-032). A single
malformed or forged snapshot should not be able to move a facility's whole position unattended.

**Alternatives considered**:
- *Overwrite the cached position plus an informational log line.* Conventional and much simpler;
  breaks replay and was explicitly rejected by the user.
- *Delete and re-derive from the snapshot.* Violates the append-only rule outright.

---

## R6. FX rate handling

**Decision**: An `FxRateProvider` **port** at `capacity/domain/ports/fx-rate.provider.ts`; the
adapters (`CachedRateProvider` wrapping a single configured source, `StaticRateProvider` seeded
from configuration for local runs and tests) live in `src/fx/`. The port sits in the domain so the
domain never imports an infrastructure module. The rate, its effective time, and its source are denormalised **onto the reservation row**
at reservation time and never re-read.

**Rationale**: Constitution I forbids implicit conversion and requires a recorded rate; the spec
fixes the rate at reservation time and reuses it for every release. Storing it on the reservation
rather than joining to a rate table at release time is deliberate: a rate table row could be
corrected or purged, and the reservation's arithmetic must remain reproducible forever. SC-008
requires local operation with no external network, which the static provider satisfies.

**Rounding**: half-up to the program currency's minor unit, via integer arithmetic on scaled
rates — never `Number`. The residual this creates on partial releases is absorbed by FR-009b's
snap-to-remainder on the final release, so a fully repaid invoice nets to exactly zero (SC-004a).

**Alternatives considered**:
- *Look up the rate at release time.* Would revalue the reservation, which the spec puts out of
  scope, and would break the net-to-zero guarantee.
- *Decimal library (`decimal.js`, `big.js`) for money.* Rejected — Constitution I mandates integer
  minor units. A decimal library is used only for the *rate*, which is not money.

---

## R7. Authentication and program scoping

**Decision**: OAuth2 client-credentials-shaped JWT bearer tokens. A global `APP_GUARD` runs
`JwtAuthGuard` on every route; `@Public()` is applied only to health probes. The token carries
`org` (owning organisation) and `scope` (`capacity:read`, `capacity:write`, `capacity:audit`). A
`ProgramScopeGuard` resolves the caller's reachable programs from the `program.organisation_id`
mapping on every request.

**Rationale**: Constitution V v2.0.0 requires exactly this: org-resolved rather than
credential-embedded program sets, read separable from write, and refusals that do not reveal
whether an out-of-scope program exists (so out-of-scope resolves to 404, never 403). Resolving per
request is what makes FR-017a work — a newly owned program is reachable without reissuing tokens.

**Token validation is pinned, not negotiated**: `HS256` only, as a single-element allow-list. The
`alg` and `kid` header fields are never inputs to key selection — that is the algorithm-confusion
and `alg: none` downgrade class, and it costs nothing to close at design time. Tokens carry `exp`
and are rejected outside a 60-second clock-skew tolerance. `org` must parse as a UUID before it is
used to resolve programs.

**Guard ordering is part of the contract**: authenticate → resolve org ownership (404 if the
program is not the caller's) → check scope (403 only once ownership is confirmed). Wired the other
way round, a scope refusal on someone else's program answers 403 where it should answer 404,
turning the guard chain itself into an existence oracle. NestJS evaluates guards in registration
order, so this is a real wiring hazard, not a theoretical one.

**Local operation**: a symmetric signing key from `.env` — an obviously-fake placeholder value,
never a plausible production secret — and a seed script that mints tokens for two organisations,
so the cross-tenant refusal (SC-007a) is demonstrable out of the box. The seed script prints
tokens to stdout only; it never writes them to a file inside the repository.

**Alternatives considered**:
- *Program ids embedded in the token.* Rejected: it breaks FR-017a, since a newly owned program
  would need reissued tokens to become reachable.
- *mTLS.* Stronger transport-level identity, but gives no natural place for scopes and makes the
  10-minute local start (SC-008) considerably harder.

---

## R8. Migrations and schema evolution

**Decision**: TypeORM migrations with explicit `up` and `down`, checked in, run via a dedicated
command. The ledger is a **plain table — not partitioned**.

**Rationale**: Constitution's technology constraints require versioned reversible migrations and
forbid hand-edited schema.

Monthly range partitioning was the original decision and it does not survive contact with
PostgreSQL. Every unique constraint on a partitioned table must contain the partition key, so
`UNIQUE (program_id, sequence)` and `PARTITION BY RANGE (occurred_at)` cannot coexist — the
`CREATE TABLE` is rejected outright. Widening the key to `(program_id, sequence, occurred_at)`
would let one `(program_id, sequence)` pair recur in different months, and gaplessness is exactly
what makes SC-004's replay check able to detect a lost or double-appended entry.

Partitioning also conflicts with the invariant it was meant to serve: `position = Σ ledger` becomes
permanently false the first time a partition is dropped, and checkpoint rows — the usual remedy —
were rejected in R3. So the retention story partitioning existed to provide was never available.
At the stated scale (hundreds of programs, low millions of reservations) a plain table with the
right indexes is comfortable for years. Retrofitting partitioning later is a real migration, and
that cost is accepted deliberately rather than paid now for a benefit that does not exist.

**Alternatives considered**:
- *Prisma.* Better ergonomics, but `prisma migrate` has no first-class down migration, and
  `SELECT … FOR UPDATE` requires raw escape hatches — both load-bearing here.
- *Drizzle / Kysely.* Excellent typed SQL and honest locking support; TypeORM chosen for its
  first-party NestJS integration and transaction/`QueryRunner` ergonomics, which keep the
  unit-of-work boundary explicit.
- *Keep partitioning, drop the gapless sequence.* Would make the ledger self-consistent but
  unauditable: a missing entry becomes undetectable, and the ledger stops being an arithmetic an
  outside party can check.

**Sequence generation**: `sequence` comes from `program.next_sequence`, incremented under the row
lock already held — never from `SELECT max(sequence)`, which is both a race and an extra scan.

---

## R9. Quarantine (dead-letter) handling

**Decision**: A dedicated `treasury.capacity.dlq` topic. The original message is republished with
headers carrying the failure reason code, the correlation id, and the original topic, partition
and offset. The handler then commits the offset and continues.

**Rationale**: FR-014 requires that unapplicable messages be retrievable and that processing
continue; SC-009 requires 0% silent loss. Republishing rather than only logging is what makes
"retrievable" true — an operator can inspect and replay. Committing after the DLQ publish, not
before, means a crash mid-quarantine replays rather than drops.

**Reason taxonomy** (documented in `contracts/errors.md`): `SCHEMA_INVALID`, `UNKNOWN_PROGRAM`,
`CURRENCY_MISMATCH`, `MISSING_ACK_MARKER`, `VERSION_CONFLICT`, `IMPLAUSIBLE_DELTA`,
`HANDLER_FAILURE`.

`HANDLER_FAILURE` is reserved for failures classified as **permanent** — see R4's transient/
permanent split. A transient failure is retried in place and never reaches this topic.

**DLQ access and replay**: the quarantine topic carries real program identifiers and real amounts,
so it is read-restricted to operations tooling under the same ACLs as the source topics (R11).
Replay re-enters through the ordinary ingestion path — validation, identity dedupe and all — never
a privileged bypass, and each replay is logged with the operator identity and the original
message's coordinates. A `dlq_depth` metric alerts on growth; a DLQ that fills silently is the
same failure as losing the messages.

---

## R10. Observability and lag reporting

**Decision**: `nestjs-pino` for JSON logs with a correlation id propagated from the HTTP
`x-correlation-id` header and from a Kafka message header. Prometheus metrics for reservation
outcomes by reason, ledger append latency, consumer lag by program, and over-limit program count.
Consumer lag is also surfaced *to clients* in the availability response.

**Rationale**: Constitution VII requires structured logs, correlation propagation, health probes
and lag metrics. FR-007a goes further than the constitution and makes lag part of the client
contract, because a client deciding whether to fund a $2M invoice needs to judge how current the
figure is. Readiness fails when the consumer is disconnected, but *not* merely because it is
lagging — a lagging service is still able to serve reads and reservations correctly (FR-007c).

---

## R11. Treasury stream authentication and authorization

**Decision**: Both treasury topics and the DLQ require `SASL_SSL` (SCRAM-SHA-512) or mTLS, with
per-topic ACLs granting **produce** on `treasury.capacity.events` and `treasury.capacity.snapshots`
to the treasury system's service identity alone, and **consume** to this service alone. The local
compose file runs the same authentication with development credentials so the production path is
the one that gets exercised.

**Rationale**: This was the largest gap in the design. Message-shape validation was thorough —
strict schemas, `additionalProperties: false`, echo detection, version comparison — and none of it
answers *who may produce*. Every one of those checks accepts a well-formed message from an
attacker. Anyone with produce access could inject a snapshot with a fabricated `reservedMinor` and
a `WATERMARK` marker dated in the future, writing off every live local reservation as
treasury-acknowledged and freeing the capacity for fraudulent reservations — with no HTTP
credential involved and no guard in the path. This is the highest-value surface in the system and
it was, as designed, unauthenticated.

**Alternatives considered**:
- *Network isolation alone.* A flat trust boundary: any compromised service on the same network
  inherits the ability to move a facility's position.
- *Payload HMAC.* Useful defence in depth and worth adding later, but it authenticates the message
  rather than the connection, and leaves the broker itself open to writes.

---

## R12. Rate limiting

**Decision**: `@nestjs/throttler` with a Redis-backed store, applied globally as an `APP_GUARD`,
keyed on the token's `org` claim (not client IP — every caller is a server). Separate buckets for
reads and writes. `429` with `Retry-After` is declared on every operation in the OpenAPI contract.

**Rationale**: It was absent from the design entirely. Row locking guarantees a hot program's
ledger stays correct under load, but it does not stop a single credential from queueing every
legitimate writer behind it on that program's lock, nor from growing the append-only ledger and
`request_record` without bound. Per-org limiting makes one tenant's traffic unable to deny service
to another's.

**Alternatives considered**:
- *Gateway-level limiting only.* Fine in production, but leaves the service undefended when run
  directly, and SC-008 requires it to be runnable standalone.
- *In-memory counters.* Simpler, but the limit multiplies by replica count, which makes it not a
  limit.

---

## Deferred, deliberately

- **Treasury producer partitioning key** — the per-program ordering assumption is unratified.
  Correctness does not depend on it (deltas dedupe by identity, snapshots compare versions), but
  throughput characteristics do. A question for the treasury team, not a blocker.
- **Program creation path in production** — out of scope per spec; local seeding only.
- **Data volume targets** — no stated program or reservation counts. The chosen design is
  comfortable across three orders of magnitude, so sizing can wait for real numbers.
