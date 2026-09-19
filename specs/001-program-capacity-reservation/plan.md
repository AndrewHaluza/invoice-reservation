# Implementation Plan: Program Capacity & Invoice Reservation

**Branch**: `001-program-capacity-reservation` | **Date**: 2026-09-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-program-capacity-reservation/spec.md`

## Summary

A NestJS service that owns the real-time capacity position of financing programs. It accepts
invoice reservations, processes releases and cancellations, and serves availability — while
consuming incremental capacity events and full-state reconciliation snapshots from an external
treasury system over Kafka.

The design rests on one structural decision: **the position is never stored as a mutable balance.**
Every change is an append-only ledger entry, and a program row carries a derived cache of the
position that is only ever advanced inside the same transaction as its ledger entry, guarded by a
`SELECT … FOR UPDATE` on the program row. A reconciliation snapshot is applied as a compensating
entry for the difference rather than an overwrite. This satisfies Constitution II and III at once
and makes the replay guarantee (SC-004, SC-004b) structurally true rather than aspirational.

Money is `BIGINT` minor units with an explicit ISO-4217 code throughout. FX is captured once at
reservation time and reused for every release against that reservation; the final release snaps to
the remaining reserved amount so a fully repaid invoice always nets to exactly zero.

## Technical Context

**Language/Version**: TypeScript 5.6 on Node.js 22 LTS, `strict` plus `noUncheckedIndexedAccess`

**Primary Dependencies**: NestJS 11 (mandated by Constitution); TypeORM 0.3 (pessimistic write
locks, reversible up/down migrations); KafkaJS 2.2 via a custom Nest transport (manual offset
commit); `class-validator` + `class-transformer` for boundary validation; `nestjs-pino` for
structured logs; `@willsoto/nestjs-prometheus` for metrics; `@nestjs/terminus` for health probes

**Storage**: PostgreSQL 16. Amounts `BIGINT` minor units; currencies `CHAR(3)`. No `NUMERIC` for
money — integers only, per Constitution I.

**Testing**: Jest for unit and integration; Testcontainers (Postgres + Redpanda) for integration
and concurrency tests; `supertest` for HTTP contract tests. Coverage gate 80% per Constitution VI.

**Target Platform**: Linux container. Local development via `docker compose up`, or `scripts/dev-stack.sh` for one isolated, per-worktree stack (parameterised host ports and a worktree-scoped compose project, so concurrent tickets never collide).

**Project Type**: Single backend web service with a Kafka consumer in the same process.

**Performance Goals**: Availability read p95 < 1s at 200 concurrent clients (SC-003). Reservation
p95 < 2s at 50 concurrent writers contending on one program (SC-003a). Treasury change visible in
reads within 5s p99 of broker append (SC-002a).

**Constraints**: Strict serialization per program on the write path; reservations must never
exceed the limit under concurrency (SC-001). No float arithmetic anywhere on money. Every endpoint
authenticated (Constitution V). Runs with no external network access (SC-008).

**Scale/Scope**: Sized for hundreds of programs and low millions of reservations — a scale at which
per-program row locking is comfortably sufficient and sharding is unnecessary. The ledger is the
growth dimension; it is a plain table, since partitioning it by month is incompatible with the
gapless per-program sequence the audit guarantee depends on (research R8).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Gate | Pre-Phase 0 | Post-Phase 1 |
|---|---|---|---|
| I. Money is never floating point | All money `BIGINT` minor units + ISO-4217 code; no `number` for amounts; FX only with recorded rate | PASS | PASS — `data-model.md` types every amount as `bigint`; `Money` value object rejects construction from `number` |
| II. Capacity is a ledger | Position derived from append-only entries; corrections are compensating entries; ledger is the recovery source | PASS | PASS *(after correction)* — `capacity_ledger_entry` append-only, with `REVOKE UPDATE, DELETE` issued in the migration; snapshot applies as per-component difference entries. **The credit limit is now a `LIMIT` ledger component**; the first design set it directly, which Principle II forbids and which made `available` unreconstructible from the audit API |
| III. Concurrency safety | Per-program row lock on every write; `locally_reserved <= limit` as a DB constraint; over-limit state obligations | PASS | PASS *(after correction)* — `SELECT … FOR UPDATE` on `program`; the invariant is a `BEFORE UPDATE` trigger firing only when this service increases its own reservations, because a plain `CHECK` aborted treasury limit *reductions*; `over_limit_since` re-evaluated on every path through one `advancePosition` function, so the mark auto-clears as the principle requires |
| IV. Idempotency and ordering | Exactly-once effect; identity dedupe before staleness; identifier reuse with different content is a typed conflict | PASS | PASS *(after correction)* — `request_record` keyed `(organisation_id, request_id)`; `processed_message` identity table; staleness now applies to snapshots only, since discarding a late *delta* as stale lost capacity silently |
| V. Authenticated by default | Global auth guard, opt-in public; org-resolved program scope; read separable from write | PASS | PASS *(HTTP)* / **the message stream was not covered** — global `APP_GUARD`, `@Public()` only on health, `ProgramScopeGuard`, per-operation `x-required-scope`, guard order pinned (own→404 before scope→403). The treasury topics had no producer authentication at all; FR-034 and research R11 now require ACLs over SASL_SSL or mTLS |
| VI. Test-first with concurrency coverage | TDD; 80% coverage; concurrency, idempotency, stale-reconciliation, currency-mismatch tests mandatory | PASS | **DEFERRED — see Complexity Tracking** — the four mandatory tests are enumerated, but test-first is a property of `/speckit-tasks` and the coverage gate is an artifact that does not exist yet |
| VII. Runnable locally, observable | `docker compose up` + `.env.example`; JSON logs with correlation id; health and metrics; documented assumptions | PASS | PASS — compose stack (per-worktree isolated via `scripts/dev-stack.sh`), seed script, `docs/ASSUMPTIONS.md` as a tracked deliverable |

**Result: PASS on I–V and VII; VI deferred to `/speckit-tasks` with a named gate.**

This table read PASS on all seven in its first version. It was wrong on three rows, and the
corrections above came out of a multi-agent design review rather than from the design itself —
worth recording, because a gate that passes itself is not a gate.

One point deserves naming rather than hiding in a table: the invariant binds
`local_reserved_minor`, not total reserved, and only in the increasing direction. That is what
Constitution III v2.0.0 requires after the over-limit amendment: the total may exceed the limit
because treasury is the system of record, and a treasury-asserted limit cut must be *recorded*
rather than refused. The over-limit condition is not a silent state — it blocks new reservations
and alerts.

## Complexity Tracking

| Item | Why it is not yet satisfied | How it closes |
|---|---|---|
| Constitution VI: test-first | No `tasks.md` exists yet, so no test precedes an implementation | `/speckit-tasks` MUST emit each mandatory test as a task ordered before the code it covers |
| Constitution VI: 80% coverage gate | Asserted in three documents, enforced in none — no `coverageThreshold`, no CI gate | First implementation task adds `jest.config.ts` with `coverageThreshold.global` at 80% and wires `test:cov` into CI, so the gate fails the build rather than a reviewer's memory |
| Constitution VI: subsystem coverage | `auth/`, `fx/`, `treasury/dlq/`, `observability/`, `config/`, `migrations/` had no test home | Test tree below now names a bucket for each; migration up/down is its own spec |
| Performance criteria SC-002/002a/003/003a | Four numeric criteria with no test vehicle — assertions, not criteria | `test/performance/` with k6 or autocannon driving each; they gate the release, not every commit |
| Treasury producer partitioning key | Unratified with the treasury team | Correctness no longer depends on it (deltas dedupe by identity); throughput does. Carried as an open question, not a blocker |

## Project Structure

### Documentation (this feature)

```text
specs/001-program-capacity-reservation/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── http-api.yaml            # OpenAPI 3.1 for the REST surface
│   ├── kafka-capacity-event.json    # Inbound incremental event schema
│   ├── kafka-reconciliation-snapshot.json  # Inbound full-state snapshot schema
│   └── errors.md                # Canonical error codes and their meaning
├── checklists/
│   └── requirements.md
└── tasks.md             # Created by /speckit-tasks, not here
```

### Source Code (repository root)

```text
src/
├── main.ts
├── app.module.ts
├── config/                    # Typed env schema, fail-fast validation at boot
├── shared/
│   ├── money/                 # Money value object, minor-unit arithmetic, rounding
│   ├── result/                # Typed domain outcomes (no exceptions for expected refusals)
│   └── correlation/           # Correlation id propagation, HTTP + Kafka
├── auth/
│   ├── jwt.strategy.ts
│   ├── jwt-auth.guard.ts      # Registered globally as APP_GUARD
│   ├── program-scope.guard.ts # Resolves org -> owned programs
│   └── public.decorator.ts
├── capacity/
│   ├── domain/                # Pure: no ORM, HTTP or Kafka imports
│   │   ├── program.ts
│   │   ├── reservation.ts
│   │   ├── ledger-entry.ts
│   │   ├── position.ts        # advancePosition(): the ONLY writer of the program row
│   │   ├── ports/
│   │   │   └── fx-rate.provider.ts   # Port lives in the domain; adapters live in fx/
│   │   └── policies/          # reserve, release, cancel, apply-event, apply-snapshot
│   ├── application/
│   │   ├── reserve.service.ts
│   │   ├── release.service.ts
│   │   ├── cancel.service.ts
│   │   ├── availability.service.ts
│   │   ├── audit-read.service.ts
│   │   ├── idempotency.service.ts
│   │   ├── apply-treasury-event.service.ts   # Owns the tx; treasury/ never writes the aggregate
│   │   ├── apply-snapshot.service.ts         # Owns the tx; marker-then-sums ordering lives here
│   │   └── reconciliation-check.job.ts       # FR-019b/FR-019f scheduled invariant verifier
│   ├── infrastructure/
│   │   ├── entities/          # TypeORM entities
│   │   ├── repositories/      # Locking repository, ledger append, position cache
│   │   └── unit-of-work.ts    # Transaction boundary + FOR UPDATE helper
│   └── api/
│       ├── capacity.controller.ts
│       ├── audit.controller.ts
│       └── dto/
├── treasury/
│   ├── consumer/              # KafkaJS consumer, manual commit, SASL_SSL/mTLS (R11)
│   ├── handlers/              # Parse, validate, dedupe, dispatch — never write the aggregate
│   ├── retry/                 # Transient/permanent classification + backoff (FR-035)
│   ├── dlq/                   # Quarantine producer + reason taxonomy
│   └── schemas/               # Runtime validation mirroring contracts/
├── fx/
│   ├── cached-rate.provider.ts
│   └── static-rate.provider.ts  # Local/dev implementation, seeded rates
├── auth/
│   ├── jwt-auth.guard.ts      # Global APP_GUARD; HS256 allow-list, no alg negotiation
│   ├── program-scope.guard.ts # Ownership resolved BEFORE scope, so out-of-scope is 404 not 403
│   ├── scope.guard.ts         # Reads x-required-scope from the operation
│   └── throttler.config.ts    # Per-org rate limiting (FR-033)
├── observability/
│   ├── health.controller.ts   # Liveness, readiness (includes consumer lag)
│   └── metrics.ts             # Includes dlq_depth, over_limit_programs, investigation_required
└── migrations/                # TypeORM up/down, versioned and reversible

test/
├── unit/                      # Domain policies, Money, rounding, position derivation, FX
├── integration/               # Testcontainers: locking, idempotency, snapshots, DLQ
│   ├── concurrency.spec.ts           # MANDATORY per Constitution VI
│   ├── idempotency.spec.ts           # MANDATORY — includes cross-org key reuse (FR-006d)
│   ├── stale-reconciliation.spec.ts  # MANDATORY — includes the late-delta case (FR-012a)
│   ├── currency-mismatch.spec.ts     # MANDATORY
│   ├── over-limit.spec.ts            # Onset, refusal, auto-clear (SC-001a)
│   ├── limit-reduction.spec.ts       # Cut below local reserved is recorded, not rejected
│   ├── snapshot-decomposition.spec.ts # Per-component deltas, treasury never negative
│   ├── ledger-recovery.spec.ts       # Per-program stream position, resume (SC-010)
│   ├── dlq.spec.ts                   # All quarantine reasons, transient retry vs quarantine
│   └── auth.spec.ts                  # Guard ordering: 404 before 403, scope enforcement
├── contract/                  # OpenAPI conformance, auth + scope enumeration (SC-007/007a)
├── migration/                 # up/down applies cleanly — Constitution merge gate
└── performance/               # SC-002, SC-002a, SC-003, SC-003a — release gate, not per-commit

docker-compose.yml             # Postgres + Redis + Redpanda; host ports parameterised
scripts/dev-stack.sh           # One isolated stack per worktree — Karst's service entrypoint
.env.example
jest.config.ts                 # coverageThreshold.global = 80% — the gate, not the aspiration
docs/ASSUMPTIONS.md            # FR-022 deliverable, Constitution VII
scripts/seed.ts                # Programs, orgs, tokens, FX rates with stated values (SC-008)
scripts/audit-ledger.ts        # SC-004: position == Σ ledger, per component
scripts/reconcile.ts           # Manual run of the FR-019b check
```

**Structure Decision**: Single NestJS service, organised by domain feature rather than by
technical layer, with a hard dependency rule inside `src/capacity`: `domain/` imports nothing from
`infrastructure/`, `api/` or Kafka. This is what makes the concurrency and financial logic unit
testable without a database, and it is the boundary Constitution's module rule requires. The Kafka
consumer runs in the same process as the HTTP server — at this scale splitting them would buy
nothing and would complicate the shared transaction boundary that snapshot application needs.

A second dependency rule, equally load-bearing and lint-enforced: **`treasury/` never writes the
capacity aggregate.** It parses, validates, deduplicates and dispatches; `capacity/application`
owns the transaction, the row lock, and the position advance. Without this rule a second module
holds write access to the aggregate's internals, and a future change to the advance sequence
updates one writer and silently misses the other.

Deployment note: the consumer sharing a process with the HTTP server means every HTTP replica
scale event triggers a consumer group rebalance, pausing treasury ingestion exactly when load is
highest — which is when the staleness figure reported to clients (FR-007a, SC-002a) matters most.
Cooperative-sticky assignment mitigates it; a separately scaled consumer deployment eliminates it
and preserves the transaction boundary, since that boundary is the shared *database*, not the
shared process. Recorded in `docs/ASSUMPTIONS.md`.
