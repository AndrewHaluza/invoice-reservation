---

description: "Task list for Program Capacity & Invoice Reservation"
---

# Tasks: Program Capacity & Invoice Reservation

**Input**: Design documents from `/specs/001-program-capacity-reservation/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: **MANDATORY, not optional.** Constitution VI is NON-NEGOTIABLE: failing test → minimal
implementation → refactor, minimum 80% coverage, with four named integration tests required before
merge. Every test task below precedes the implementation it covers, and T004 makes the coverage
floor a build failure rather than a reviewer's memory.

**Organization**: Grouped by user story so each is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1–US6, mapping to spec.md user stories
- Exact file paths in every description

## Path Conventions

Single NestJS service. `src/` and `test/` at repository root, per plan.md's Project Structure.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization. Nothing domain-specific yet.

- [x] T001 Initialize NestJS 11 project on Node.js 22 LTS with TypeScript 5.6 in strict mode (`strict: true`, `noUncheckedIndexedAccess: true`) — `package.json`, `tsconfig.json`, `nest-cli.json`
- [x] T002 [P] Install runtime dependencies: `@nestjs/typeorm`, `typeorm`, `pg`, `kafkajs`, `class-validator`, `class-transformer`, `nestjs-pino`, `@nestjs/terminus`, `@nestjs/throttler`, `@nestjs/jwt`, `prom-client` in `package.json`
- [x] T003 [P] Install dev dependencies: `jest`, `ts-jest`, `@nestjs/testing`, `testcontainers`, `@testcontainers/postgresql`, `supertest`, `eslint`, `prettier` in `package.json`
- [x] T004 Create `jest.config.ts` with `coverageThreshold.global` at 80% for branches, functions, lines and statements — **this is the Constitution VI gate; it must fail the build, not warn**
- [x] T005 [P] Configure ESLint with an import-boundary rule (`eslint-plugin-boundaries` or equivalent) enforcing the two dependency rules from plan.md: `capacity/domain/` imports nothing from `infrastructure/`, `api/` or Kafka; `treasury/` imports no capacity repository or unit-of-work, in `.eslintrc.cjs`
- [x] T006 [P] Create `docker-compose.yml` with PostgreSQL 16 and Redpanda, Redpanda configured with SASL_SSL and development credentials so the authenticated path is the one exercised locally (research R11)
- [x] T006a [P] Parameterise every published host port in `docker-compose.yml` (`PG_PORT`, `REDIS_PORT`, `KAFKA_PORT`, `KAFKA_SASL_PORT`, `REDPANDA_ADMIN_PORT`, defaulting to the canonical ports) with Redpanda advertising the published port on its host-facing listeners and bootstrapping over a separate in-container listener, and add `scripts/dev-stack.sh` — a worktree-scoped compose project plus derived connection strings, so several tickets run complete, isolated stacks concurrently (see quickstart.md, “One stack per worktree”)
- [x] T007 [P] Create `.env.example` with an obviously-fake JWT signing key placeholder (e.g. `JWT_SECRET=dev-only-not-a-real-secret`), database and broker settings, and the FR-032 delta guard proportion
- [x] T008 [P] Create `src/config/` with a schema-validated configuration module that fails fast at startup when a required secret is absent

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Everything every story depends on. **No user story work may begin until this phase completes.**

**⚠️ CRITICAL**: T012 and T019 encode the arithmetic the entire feature rests on. Get them wrong and every story is wrong.

**Phase 1 carry-over closed here** (found while planning this phase; see
`docs/plans/2026-09-19-phase-2-foundational.md`): `src/config/data-source.ts` is referenced by the
`migration:run` script but was never created; `test:unit` invokes `--selectProjects unit` against a
Jest config that defines no projects; `docker-compose.yml` has no Redis service although T030
requires a Redis-backed throttler store; and the `eslint-plugin-boundaries` v7 selector migration
did not make the Phase 1 merge, so `eslint.config.mjs` still carries deprecated bare element
selectors that begin emitting warnings the moment T022 creates the first file matching an element
pattern. T015 additionally depends on a non-owner `app_role` member existing, without which the
T019 `REVOKE` does not bind (see data-model.md). All are prerequisites of T015 and are sequenced
ahead of it in the execution plan.

### Money and shared kernel

- [x] T009 [P] Write failing unit tests for the `Money` value object in `test/unit/money.spec.ts`: construction from `number` is rejected, currency must match `^[A-Z]{3}$`, arithmetic across differing currencies throws, values beyond `Number.MAX_SAFE_INTEGER` survive a round trip
- [x] T010 [P] Implement `Money` in `src/shared/money/money.ts` as `bigint` minor units plus an ISO-4217 `CHAR(3)` code. No `number` accepted anywhere in the public surface (Constitution I)
- [x] T011 [P] Write failing unit tests for half-up rounding and FX conversion in `test/unit/rounding.spec.ts`, including the 1 JPY → USD case that rounds to zero minor units
- [x] T012 Implement half-up rounding and FX conversion in `src/shared/money/convert.ts` using integer arithmetic on scaled rates — never `Number` (research R6). A conversion resulting in 0 minor units returns a typed `AmountRoundsToZero` outcome, not a throw
- [x] T013 [P] Implement the `Result` type in `src/shared/result/result.ts` so expected refusals are typed return values rather than exceptions (plan.md's domain rule)
- [x] T014 [P] Implement correlation-id propagation in `src/shared/correlation/` — read `x-correlation-id` (max 128 chars) from HTTP and from a Kafka header, generate when absent, treat as untrusted string data that is never interpolated into a log format or SQL string

### Schema and migrations

- [x] T015 Create the initial TypeORM migration in `src/migrations/` for `organisation`, `program`, `invoice_reservation`, `capacity_ledger_entry`, `request_record`, `processed_message`, `stream_position`, `program_stream_position`, `snapshot_acknowledgement`, `fx_rate`, with explicit `up` and `down`, per data-model.md
- [x] T016 Add all enum types to the migration: `reservation_status` (`ACTIVE`, `PARTIALLY_RELEASED`, `FULLY_RELEASED`, `CANCELLED`, `WRITTEN_OFF`), `reservation_origin` (`LOCAL`, `TREASURY`), `position_component` (`LOCAL`, `TREASURY`, `LIMIT`), `ledger_cause` (`RESERVATION`, `RELEASE`, `CANCELLATION`, `WRITE_OFF`, `TREASURY_EVENT`, `LIMIT_CHANGE`, `RECONCILIATION_ADJUSTMENT`, `OVER_LIMIT_ONSET`, `OVER_LIMIT_CLEARED`), `request_state` (`PENDING`, `COMPLETE`), `message_kind` (`EVENT`, `SNAPSHOT`), `ack_kind` (`EXPLICIT`, `WATERMARK`)
- [x] T017 Add every `CHECK` constraint from data-model.md to the migration verbatim, including `CHECK (local_reserved_minor >= 0)`, `CHECK (treasury_reserved_minor >= 0)`, `CHECK (credit_limit_minor >= 0)`, `CHECK (currency ~ '^[A-Z]{3}$')`, `CHECK (outstanding_reserved_minor BETWEEN 0 AND reserved_minor)`, `CHECK (treasury_acknowledged = (acknowledged_by_version IS NOT NULL))`, and `CHECK ((invoice_currency = program_currency) = (fx_rate IS NULL))` — the last is only expressible because `program_currency` is denormalised onto `invoice_reservation`
- [x] T018 Add the `assert_local_within_limit()` function and the `program_local_within_limit` trigger to the migration, with `WHEN (NEW.local_reserved_minor > OLD.local_reserved_minor)` exactly as specified — **the `WHEN` clause is the whole point: without it the trigger aborts treasury limit reductions** (FR-011c, Constitution III v2.1.0)
- [x] T019 Add `REVOKE UPDATE, DELETE ON capacity_ledger_entry FROM app_role;` to the migration, and `PRIMARY KEY (organisation_id, request_id)` on `request_record` — **composite, never `request_id` alone** (FR-006d)
- [x] T020 [P] Add every index from data-model.md to the migration, including the partial index `ON invoice_reservation (program_id) WHERE origin = 'LOCAL' AND NOT treasury_acknowledged` and `ON capacity_ledger_entry (program_id, cause, sequence DESC)`
- [x] T021 Write `test/migration/migration.spec.ts` asserting `up` then `down` then `up` applies cleanly against a Testcontainers Postgres — the Constitution merge gate that had no artifact
- [x] T022 [P] Create TypeORM entities in `src/capacity/infrastructure/entities/` mapping every column, with `bigint` transformers that produce `bigint` and never `number`

### Position arithmetic — the core

- [x] T023 Write failing unit tests for `advancePosition` in `test/unit/position.spec.ts`: each component's cache equals the sum of its entries; over-limit is marked on onset and **cleared on any path that brings the total back within the limit**, including release, cancel and a limit *increase*; `OVER_LIMIT_ONSET`/`OVER_LIMIT_CLEARED` carry `delta_minor = 0` and `component = 'LIMIT'`
- [x] T024 Implement `advancePosition(program, entries)` in `src/capacity/domain/position.ts` — appends entries, assigns `sequence` from `program.next_sequence`, advances the `LOCAL`, `TREASURY` and `LIMIT` caches, re-evaluates the over-limit mark, emits marker entries when it changes. **This is the only function permitted to write the program row** (data-model.md)
- [x] T025 Implement the locking repository and unit-of-work in `src/capacity/infrastructure/unit-of-work.ts` and `repositories/`: `SELECT … FROM program WHERE id = $1 FOR UPDATE` at `READ COMMITTED` at the head of every write transaction (research R1). Any future multi-program transaction must lock in `ORDER BY id` — document this in the file

### Auth, rate limiting, observability

- [x] T026 [P] Write failing tests for guard ordering in `test/integration/auth.spec.ts`: a token for another organisation gets **404 before any scope check runs**; a correctly-owned program with a wrong scope gets 403; `alg: none` and an RS256-signed token are both rejected; an expired token is rejected outside 60s skew
- [x] T027 Implement `src/auth/jwt-auth.guard.ts` as a global `APP_GUARD` with an HS256-only allow-list. The `alg` and `kid` header fields MUST NOT influence key selection (research R7). Validate `exp` with 60-second skew tolerance and require `org` to parse as a UUID
- [x] T028 Implement `src/auth/program-scope.guard.ts` resolving the caller's programs from `program.organisation_id` on every request, and `src/auth/scope.guard.ts` reading `x-required-scope` from the operation. **Register them so ownership resolves before scope** — NestJS evaluates guards in registration order, and the wrong order turns the guard chain into an existence oracle (FR-017, research R7)
- [x] T029 [P] Implement `@Public()` and apply it to `/health/live` and `/health/ready` only, in `src/auth/public.decorator.ts`
- [x] T030 [P] Implement per-organisation rate limiting in `src/auth/throttler.config.ts` using `@nestjs/throttler` with a Redis store, keyed on the token's `org` claim rather than client IP, with separate read and write buckets, returning 429 plus `Retry-After` (FR-033, research R12)
- [x] T031 [P] Implement `nestjs-pino` structured JSON logging and the global `ValidationPipe` with `whitelist: true` in `src/main.ts` and `src/app.module.ts` (Constitution V)
- [x] T032 [P] Implement Prometheus metrics in `src/observability/metrics.ts`: reservation outcomes by reason, ledger append latency, consumer lag by program, over-limit program count, `dlq_depth`, and count of programs with `investigation_required` (research R10)
- [x] T033 [P] Implement `src/observability/health.controller.ts` with `/health/live` and `/health/ready`. Readiness fails when the consumer is disconnected but **not** merely when lagging. The response body is the minimal `Health` schema — it names no host, broker, connection string or version (contracts/http-api.yaml)

### Seed and local run

- [x] T034 [P] Implement `scripts/seed.ts` creating 2 organisations, 3 programs, tokens for each org, and FX rates with **stated values — EUR→USD at 1.0850000000, effective at epoch, source `seed`** (quickstart.md Scenario 4 depends on this exact rate to be checkable). Tokens print to stdout only, never to a file in the repository

**Checkpoint**: Foundation ready. `docker compose up` starts, migrations apply and roll back, auth refuses correctly, the coverage gate is live. User stories can now proceed.

---

## Phase 3: User Story 1 — Reserve capacity when an invoice is approved (Priority: P1) 🎯 MVP

**Goal**: An authorized caller reserves a portion of a program's capacity for an approved invoice, in any currency, and the reservation can never push this service's own reservations past the limit.

**Independent Test**: Reserve against a seeded program, read availability back, observe the reduction. Drive 1,000 concurrent attempts at a limit that admits only some and confirm the limit is never breached.

### Tests for User Story 1 ⚠️ WRITE FIRST, CONFIRM FAILING

- [x] T035 [P] [US1] **MANDATORY (Constitution VI)** Write `test/integration/concurrency.spec.ts`: 1,000 concurrent reservations against a program whose limit admits a known subset, asserting the limit is never breached, the ledger sums to the cached position, and no request fails for contention alone (SC-001, SC-003a). Must run real parallel transactions through Testcontainers — a mocked repository cannot demonstrate this
- [x] T036 [P] [US1] **MANDATORY (Constitution VI)** Write `test/integration/currency-mismatch.spec.ts`: a reservation in a currency with no rate is refused `FX_RATE_UNAVAILABLE`
- [x] T037 [P] [US1] Write `test/unit/reserve-policy.spec.ts`: refuses when `position_verified` is false, when over-limit, when the converted amount rounds to zero, and when the amount exceeds available — **in that order**, each as a distinct typed outcome
- [x] T038 [P] [US1] Write `test/contract/reservations.contract.spec.ts` asserting `POST /v1/programs/{programId}/reservations` conforms to `contracts/http-api.yaml`, including that `amountMinor` is a string and 429/503 are reachable

### Implementation for User Story 1

- [x] T039 [P] [US1] Implement the `FxRateProvider` port in `src/capacity/domain/ports/fx-rate.provider.ts` — **the port lives in the domain so the domain never imports an infrastructure module** (research R6)
- [x] T040 [P] [US1] Implement `src/fx/static-rate.provider.ts` and `src/fx/cached-rate.provider.ts` as adapters, selecting with `WHERE base = ? AND quote = ? AND effective_at <= now() ORDER BY effective_at DESC LIMIT 1`
- [x] T041 [US1] Implement the reserve policy in `src/capacity/domain/policies/reserve.policy.ts` returning typed outcomes: `POSITION_UNVERIFIED`, `PROGRAM_OVER_LIMIT`, `AMOUNT_ROUNDS_TO_ZERO`, `INSUFFICIENT_CAPACITY`, `FX_RATE_UNAVAILABLE`. The trigger is the backstop, never the primary gate (data-model.md)
- [x] T042 [US1] Implement `src/capacity/application/idempotency.service.ts`: insert a `PENDING` `request_record` **in the same transaction as the work, before applying it**, keyed `(organisation_id, request_id)`. A PK violation means a concurrent duplicate → `REQUEST_IN_FLIGHT`. Matching fingerprint → replay `outcome`; differing → `IDEMPOTENCY_CONFLICT`; `outcome` nulled by retention → `IDEMPOTENCY_EXPIRED` (FR-006–006e)
- [x] T043 [US1] Implement `src/capacity/application/reserve.service.ts`: open the transaction, take `FOR UPDATE`, run the idempotency check, resolve and **denormalise the FX rate, its effective time and its source onto the reservation row**, call `advancePosition` with a `+A` `LOCAL` entry, cause `RESERVATION` (FR-008, research R6)
- [x] T044 [US1] Implement `src/capacity/api/dto/create-reservation.dto.ts` with `class-validator`: `invoiceId` max length 128, `amount.amountMinor` matching `^-?[0-9]{1,19}$` **and validated to fit a signed 64-bit integer before casting** — the pattern alone admits values that overflow `BIGINT`
- [x] T045 [US1] Implement `POST /v1/programs/{programId}/reservations` in `src/capacity/api/capacity.controller.ts` with `x-required-scope: capacity:write`, a required `Idempotency-Key` header, 201 on create and 200 on idempotent replay
- [x] T046 [US1] Implement the error filter in `src/capacity/api/error.filter.ts` mapping every typed outcome to its code and status from `contracts/errors.md`, with `details` carrying field-level information only — never a stack trace, SQL fragment, or another organisation's identifier

**Checkpoint**: US1 is independently functional. Reservations are safe under contention and never exceed the limit.

---

## Phase 4: User Story 2 — Release capacity when an invoice is repaid (Priority: P1)

**Goal**: Repayment returns capacity, in the invoice's own currency, at the rate fixed on the reservation, so a fully repaid invoice nets to exactly zero.

**Independent Test**: Reserve a cross-currency invoice, repay in two instalments, confirm status `FULLY_RELEASED` and outstanding `"0"` with no stranded minor units.

### Tests for User Story 2 ⚠️ WRITE FIRST, CONFIRM FAILING

- [x] T103 [US2] Correct the `CachedRateProvider` cache key in `src/fx/cached-rate.provider.ts` so a cached rate is served only when `asOf >= entry.effectiveAt`
- [x] T047 [P] [US2] Write `test/unit/release-policy.spec.ts`: **the `RELEASE_EXCEEDS_RESERVED` check runs on the pre-snap `Δ`** — an over-release is refused, never silently clamped (Constitution III forbids silent clamping); only then does the snap to remainder apply
- [x] T048 [P] [US2] Write `test/integration/release-nets-to-zero.spec.ts`: a 33333 EUR invoice against a USD program at 1.085 reserves 36166, and two instalments net to exactly zero with zero residual (SC-004a)
- [x] T049 [P] [US2] Write `test/contract/releases.contract.spec.ts` asserting `CURRENCY_MISMATCH` returns **409, matching both `contracts/errors.md` and the OpenAPI** — these disagreed before and a client branching on status would have been wrong either way

### Implementation for User Story 2

- [x] T050 [US2] Implement the release policy in `src/capacity/domain/policies/release.policy.ts`: `Δ = round_half_up(R × fx_rate)`; refuse if `Δ > outstanding_reserved_minor`; **then** snap `Δ := outstanding_reserved_minor` when `R = outstanding_invoice_minor` or `outstanding_reserved_minor − Δ < 1` (FR-009b). Refuse a release denominated in any currency but the invoice's own
- [x] T051 [US2] Implement `src/capacity/application/release.service.ts` under the row lock, appending `−Δ` `LOCAL` with cause `RELEASE` via `advancePosition`, and advancing `status` through `PARTIALLY_RELEASED` → `FULLY_RELEASED`
- [x] T052 [P] [US2] Implement `src/capacity/api/dto/create-release.dto.ts` with the same bounded-amount validation as T044
- [x] T053 [US2] Implement `POST /v1/programs/{programId}/reservations/{invoiceId}/releases` in `src/capacity/api/capacity.controller.ts` with `x-required-scope: capacity:write`

**Checkpoint**: Reserve and release both work. The money story is closed and nets to zero.

---

## Phase 5: User Story 4 — Read current availability and audit history (Priority: P1)

**Goal**: A client reads a program's position and judges how current it is; an auditor reproduces that position from the API alone.

**Independent Test**: Reserve, then immediately read — the caller's own change is visible. Read the ledger and sum it per component; the three reported figures reproduce exactly.

> Sequenced before US3/US5/US6 because it is P1 and because SC-004b is what proves the ledger design works at all.

### Tests for User Story 4 ⚠️ WRITE FIRST, CONFIRM FAILING

- [x] T054 [P] [US4] Write `test/integration/read-your-writes.spec.ts`: 10,000 reserve-then-read trials, the caller's own accepted change visible in 100% of them (SC-002). **Reads must go to the primary** — record this constraint in `docs/ASSUMPTIONS.md`, since a read replica would break FR-007b
- [x] T055 [P] [US4] Write `test/integration/ledger-audit.spec.ts`: summing ledger entries per component reproduces `local_reserved_minor`, `treasury_reserved_minor` **and `credit_limit_minor`** — the limit is a ledger component, so `available` is fully reconstructible from the audit API (SC-004b, FR-019a)
- [x] T056 [P] [US4] Write `test/contract/availability.contract.spec.ts`: `available` is **signed and never floored** — a negative figure is the honest over-limit magnitude, and flooring would conceal exactly what the over-limit state exists to surface

### Implementation for User Story 4

- [x] T057 [US4] Implement `src/capacity/application/availability.service.ts` returning limit, reserved (total/local/treasury), signed available, over-limit state, `positionChangedAt`, treasury applied version, effective time and `lagSeconds`, plus `positionVerified`, `investigationRequired` and `reconciliationPending` (FR-007, FR-007a, FR-019f)
- [x] T058 [US4] Implement `src/capacity/application/audit-read.service.ts` for listing reservations and reading ledger entries, **paging on `sequence DESC`, not `occurred_at`** — `sequence` is gapless and totally ordered per program, so a cursor over it is deterministic on ties (FR-031)
- [x] T059 [US4] Implement `GET /availability`, `GET /reservations`, `GET /reservations/{invoiceId}` in `src/capacity/api/capacity.controller.ts` with `x-required-scope: capacity:read`
- [x] T060 [US4] Implement `GET /ledger` with time-range and cause filtering in `src/capacity/api/audit.controller.ts` with `x-required-scope: capacity:audit`
- [x] T061 [P] [US4] Implement `scripts/audit-ledger.ts` replaying every program's ledger and asserting per-component equality with the cached position; wire as `npm run audit:ledger` (SC-004)

**Checkpoint**: The position is readable, current, and independently verifiable by an outside party.

---

## Phase 6: User Story 3 — Cancel a reservation that will never be funded (Priority: P2)

**Goal**: Capacity tied to an invoice that will never be funded is returned, recorded with a cause distinct from repayment.

**Independent Test**: Cancel an active reservation, confirm capacity returns and the ledger shows `CANCELLATION` rather than `RELEASE`. A second cancellation is refused as terminal.

### Tests for User Story 3 ⚠️ WRITE FIRST, CONFIRM FAILING

- [x] T062 [P] [US3] Write `test/integration/cancellation.spec.ts`: cancel returns all remaining capacity; the ledger cause is `CANCELLATION` or `WRITE_OFF`, distinguishable from `RELEASE`; a partially released reservation cancels to `WRITTEN_OFF` while an untouched one goes to `CANCELLED`; repeat cancellation is `RESERVATION_TERMINAL` (FR-025–027)
- [x] T063 [P] [US3] Write `test/unit/no-auto-expiry.spec.ts` proving no code path expires a reservation through the passage of time (FR-028) — a negative requirement that had no test

### Implementation for User Story 3

- [x] T064 [US3] Implement the cancel policy in `src/capacity/domain/policies/cancel.policy.ts`, refusing any reservation already in a terminal state
- [x] T065 [US3] Implement `src/capacity/application/cancel.service.ts` appending `−outstanding_reserved_minor` `LOCAL` with cause `CANCELLATION` or `WRITE_OFF` via `advancePosition`
- [x] T066 [P] [US3] Implement `src/capacity/api/dto/cancellation.dto.ts` with the required `reason` enum and its max-length note — and note that `cancelReservation` **does** declare 400, which it previously did not despite a required enum body
- [x] T067 [US3] Implement `POST /v1/programs/{programId}/reservations/{invoiceId}/cancellation` in `src/capacity/api/capacity.controller.ts` with `x-required-scope: capacity:write`

**Checkpoint**: All three capacity-moving operations work, and an audit can tell why capacity was returned.

---

## Phase 7: User Story 5 — Apply treasury capacity updates from the event stream (Priority: P2)

**Goal**: Incremental treasury changes reach the position exactly once, in any order, without this service's own bookings being double-counted.

**Independent Test**: Publish an event, observe the position move. Replay it byte-for-byte, observe nothing change. Publish an event older than the applied snapshot version and observe that it **still applies**.

### Tests for User Story 5 ⚠️ WRITE FIRST, CONFIRM FAILING

- [x] T068 [P] [US5] **MANDATORY (Constitution VI)** Write `test/integration/idempotency.spec.ts`: duplicate message delivery changes the position once; **two organisations reusing the same `Idempotency-Key` neither collide nor replay one another's outcome** (FR-006d); a reused key with different content is `IDEMPOTENCY_CONFLICT` (SC-005)
- [x] T069 [P] [US5] Write `test/integration/late-delta.spec.ts`: an incremental event whose version is **below** the applied snapshot version still applies exactly once (FR-012a). Discarding it would lose capacity permanently with no quarantine and no alert — SC-009's 0% silent loss violated by design rather than by bug
- [x] T070 [P] [US5] Write `test/integration/echo-suppression.spec.ts`: an event whose `reservationReference` names a reservation this service originated is skipped, so the same reservation is not counted once as `LOCAL` and again as `TREASURY` (FR-010a)
- [x] T071 [P] [US5] Write `test/integration/dlq.spec.ts` covering every quarantine reason — `SCHEMA_INVALID`, `UNKNOWN_PROGRAM`, `CURRENCY_MISMATCH`, `MISSING_ACK_MARKER`, `VERSION_CONFLICT`, `IMPLAUSIBLE_DELTA`, `HANDLER_FAILURE` — and asserting a **transient** failure is retried in place and never reaches the DLQ (FR-035, SC-009)
- [x] T036a [US5] **MANDATORY (Constitution VI)** Write `test/integration/currency-mismatch.spec.ts`: a treasury message asserting a currency other than the program's is quarantined `CURRENCY_MISMATCH` and never converted (FR-013c, FR-013d)
  Note: moved here from Phase 3 (T036) because the Kafka consumer that can produce this quarantine outcome does not arrive until Phase 7.

### Implementation for User Story 5

- [x] T072 [US5] Implement the KafkaJS consumer in `src/treasury/consumer/` with `autoCommit: false` and **manual offset commit only after the handling transaction commits**, connecting over SASL_SSL/mTLS (research R4, R11)
- [x] T073 [P] [US5] Implement runtime schema validation in `src/treasury/schemas/` mirroring `contracts/*.json`, including the bounded-digit check so a 40-digit amount string is rejected before it overflows `BIGINT`
- [x] T074 [US5] Implement transient/permanent failure classification in `src/treasury/retry/`: connection loss, pool exhaustion, lock timeout and serialization failure are transient and retried with bounded exponential backoff **without committing the offset**. Only a message that can never apply may be quarantined (FR-035)
- [x] T075 [US5] Implement `src/treasury/dlq/` republishing the original message to `treasury.capacity.dlq` with reason, correlation id, and original topic/partition/offset headers, committing the offset only after the DLQ publish succeeds (research R9)
- [x] T076 [US5] Implement `src/treasury/handlers/capacity-event.handler.ts` — **parse, validate, dedupe by message identity, dispatch. It must not open a transaction or write the aggregate** (plan.md's second dependency rule)
- [x] T077 [US5] Implement `src/capacity/application/apply-treasury-event.service.ts` owning the transaction and the row lock: write `processed_message` **in the same transaction as the ledger entry**, apply `RESERVATION_BOOKED`/`RESERVATION_RELEASED` to the `TREASURY` component, and apply `LIMIT_CHANGED` as a signed difference against the `LIMIT` component — never as a direct write (FR-011, FR-013)
- [x] T078 [US5] Implement echo suppression by matching `payload.reservationReference` against `invoice_reservation.treasury_reference` in the same service (FR-010a)
- [x] T079 [US5] Implement per-program stream position tracking in `src/capacity/infrastructure/repositories/stream-position.repository.ts`, writing `program_stream_position` in the same transaction as the ledger entry (FR-019d)

**Checkpoint**: Treasury increments apply exactly once, in any order, with double-counting suppressed and nothing silently lost.

---

## Phase 8: User Story 6 — Apply bulk reconciliation snapshots (Priority: P2)

**Goal**: A periodic full-state assertion brings a program up to date as compensating ledger entries, without erasing reservations treasury has not yet seen and without freezing on its own arithmetic.

**Independent Test**: Reserve 500,000 locally, apply a snapshot asserting 3,500,000 reserved with a watermark predating the reservation; total reads 4,000,000, and the adjustment lands on the `TREASURY` component alone.

### Tests for User Story 6 ⚠️ WRITE FIRST, CONFIRM FAILING

- [x] T080 [P] [US6] **MANDATORY (Constitution VI)** Write `test/integration/stale-reconciliation.spec.ts`: a snapshot older than the applied version is ignored and changes nothing; an equal-version-differing-content snapshot is quarantined `VERSION_CONFLICT`, never arbitrated; the applied-version marker advances on a zero-delta snapshot **while no entry is written** (SC-006, FR-012)
- [x] T081 [P] [US6] Write `test/integration/snapshot-decomposition.spec.ts`: a snapshot acknowledging local reservations produces a **non-negative** `target_treasury`; corrections land per component; a non-zero local correction sets `investigation_required` rather than being absorbed into the treasury column (FR-011f, FR-011g). **A single blended delta drives the treasury component negative here and freezes the program permanently — that is the case this test exists to prevent**
- [x] T082 [P] [US6] Write `test/integration/ack-marker.spec.ts`: an `EXPLICIT` marker matches `treasury_reference`; a `WATERMARK` marker acknowledges reservations whose `confirmed_at <= ingestedThrough`; the marker is applied **before** the sums are computed; a marker from a snapshot older than `acknowledged_by_version` does not flag (FR-011d, FR-011e)
- [x] T083 [P] [US6] Write `test/integration/limit-reduction.spec.ts`: treasury cutting the limit below this service's own reservations is **applied**, the program is marked over-limit, and the mark clears automatically once releases bring the total back within the limit (FR-011c, SC-001a). A plain `CHECK` aborts this transaction — the test exists to keep the trigger's `WHEN` clause honest
- [x] T084 [P] [US6] Write `test/integration/over-limit.spec.ts`: while over-limit, 100% of new reservations are refused `PROGRAM_OVER_LIMIT`; onset and clearance are both recorded as ledger entries (SC-001a, FR-023, FR-024)

### Implementation for User Story 6

- [x] T085 [US6] Implement `src/treasury/handlers/reconciliation-snapshot.handler.ts` — validation, identity dedupe, version comparison, `MISSING_ACK_MARKER` quarantine. Dispatch only; no transaction
- [x] T086 [US6] Implement `src/capacity/domain/policies/apply-snapshot.policy.ts` computing, **in this order**: apply the acknowledgement marker, then `acked_local` and `local_total`, then `target_treasury = snapshot.reservedMinor − acked_local`, `target_local = local_total`, and the three deltas. The ordering is not incidental — marker-then-sums and sums-then-marker differ by exactly the amount newly acknowledged (FR-011d)
- [x] T087 [US6] Implement `src/capacity/application/apply-snapshot.service.ts` owning the transaction, appending **one `RECONCILIATION_ADJUSTMENT` entry per non-zero component delta** and none for a zero delta, and persisting the marker to `snapshot_acknowledgement` so the decision is auditable and reproducible on replay (FR-011e, FR-011f)
- [x] T088 [US6] Implement the FR-032 magnitude guard in the same service: a snapshot implying `|delta_treasury|` above the configured proportion of the credit limit is quarantined `IMPLAUSIBLE_DELTA` for operator review rather than auto-applied
- [x] T089 [US6] Implement `reconciliationPending` detection — set when an applied snapshot acknowledged a reservation since released, so a client sees the figure is known to be conservative rather than discovering it by arithmetic (spec.md Trade-offs)

**Checkpoint**: All six stories complete. Snapshots reconcile without erasing in-flight reservations and without freezing.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [x] T090 Implement `src/capacity/application/reconciliation-check.job.ts` — the scheduled FR-019b verifier comparing active reservations against the `LOCAL` component, setting `investigation_required`, emitting its result as a metric, **and never self-correcting**. This existed only as a column before (FR-019f, SC-004c)
- [x] T091 [P] Implement `scripts/reconcile.ts` for a manual run of the same check
- [x] T092 Implement recovery detection: on startup, a program whose `program_stream_position` is missing or behind its ledger gets `position_verified = FALSE`, refusing writes with `POSITION_UNVERIFIED` **per program, not service-wide**, until a fresh snapshot re-establishes it (FR-019e)
- [x] T093 [P] Write `test/integration/ledger-recovery.spec.ts`: restore from a ledger backup, resume the stream from the recorded per-program position, assert no reservation lost and no message applied twice (SC-010). Wire as `npm run test:recovery`
- [x] T094 [P] Write `test/contract/auth-enumeration.contract.spec.ts` enumerating every route to prove authentication **and scope** are enforced, excepting the two `security: []` health probes, and asserting `details` never contains a `stack`, `sql` or `query` key (SC-007, SC-007a)
- [x] T095 [P] Write `test/performance/` harnesses for SC-002a (treasury change visible within 5s p99), SC-003 (availability read p95 < 1s at 200 concurrent clients) and SC-003a (reservation p95 < 2s at 50 contending writers, no failure from contention alone). Wire as `npm run test:perf` — a release gate, not per-commit
- [x] T096 Write `docs/ASSUMPTIONS.md` (FR-022, Constitution VII), recording at minimum: reads go to the primary; the consumer shares a process with the HTTP server so scaling triggers a rebalance that pauses ingestion, mitigated by cooperative-sticky assignment; the treasury producer's partitioning key is unratified and affects throughput but not correctness; snapshot over-reporting between a release and the next snapshot; and partitioning dropped rather than deferred
- [x] T097 [P] Add Kafka topic ACL configuration and documentation covering both treasury topics and the DLQ: produce restricted to the treasury identity, consume restricted to this service, DLQ read restricted to operations tooling, replay routed through the ordinary validation path (FR-034, FR-036, research R11)
- [x] T098 Run the full `quickstart.md` — all ten scenarios — against a fresh `docker compose up`, confirming a working service inside 10 minutes from clone (SC-008)
- [x] T099 Verify `npm run test:cov` reports ≥ 80% and that the T004 threshold fails the build when it does not. Confirm every subsystem has a test home: `auth/`, `fx/`, `treasury/dlq/`, `observability/`, `config/`, `migrations/`
- [x] T100 Remove the Sync Impact Report HTML comment from `.specify/memory/constitution.md` before the first commit — it is temporary review scratch, not governance content
- [x] T101 Implement the FR-006b retention sweep over `request_record` in `src/capacity/application/request-retention.job.ts`, setting `state='EXPIRED'` and `outcome=NULL` for `COMPLETE` rows older than `REQUEST_RETENTION_DAYS` while keeping the row so a reused identifier stays distinguishable from a new one
- [x] T102 Extend `scripts/verify-uat.sh` to the phase 3–8 acceptance criteria

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup. **BLOCKS every user story.** T012 (rounding) and T024 (`advancePosition`) are the arithmetic everything else rests on
- **US1 (Phase 3)**: Depends on Foundational. MVP
- **US2 (Phase 4)**: Depends on US1 — a release needs a reservation to release against
- **US4 (Phase 5)**: Depends on Foundational; richer to test after US1/US2 exist
- **US3 (Phase 6)**: Depends on US1
- **US5 (Phase 7)**: Depends on Foundational; independent of US1–US4 except for echo suppression (T078), which needs US1's reservation rows
- **US6 (Phase 8)**: Depends on US5 (shares the consumer, DLQ and dedupe) and on US1 (the additive rule needs local reservations to be additive over)
- **Polish (Phase 9)**: Depends on all stories

### Within Each User Story

Tests written and **confirmed failing** → domain policy → application service → DTO → controller → error mapping.

### Parallel Opportunities

- Setup: T002, T003, T005, T006, T007, T008 in parallel
- Foundational: the money kernel (T009–T014) is parallel with the auth and observability block (T026–T034). Migration tasks T015–T020 are sequential — one file
- Every story's test tasks marked [P] are parallel with each other
- Once Foundational completes, US1 and US5 can proceed in parallel on separate tracks; US2/US3/US4 follow US1, US6 follows US5

---

## Parallel Example: User Story 1

```bash
# Tests first — all four in parallel, all must fail before any implementation
Task: "Write test/integration/concurrency.spec.ts"
Task: "Write test/integration/currency-mismatch.spec.ts"
Task: "Write test/unit/reserve-policy.spec.ts"
Task: "Write test/contract/reservations.contract.spec.ts"

# Then the FX pair in parallel
Task: "Implement src/capacity/domain/ports/fx-rate.provider.ts"
Task: "Implement src/fx/static-rate.provider.ts and cached-rate.provider.ts"
```

---

## Implementation Strategy

### MVP (US1 only)

1. Phase 1: Setup
2. Phase 2: Foundational — **critical, blocks everything**
3. Phase 3: US1
4. **STOP and VALIDATE**: `concurrency.spec.ts` green, quickstart Scenarios 1 and 2 pass
5. Demo: a program whose capacity is reserved safely under contention

### Incremental Delivery

1. Setup + Foundational → foundation ready
2. + US1 → reserve works → **MVP**
3. + US2 → the money story closes and nets to zero
4. + US4 → position readable and independently auditable
5. + US3 → cancellation distinguishable from repayment
6. + US5 → treasury increments apply exactly once
7. + US6 → snapshots reconcile without erasing in-flight reservations
8. + Polish → recovery, reconciliation job, performance gates, assumptions

### Parallel Team Strategy

Foundational together, then: developer A takes US1 → US2 → US3; developer B takes US5 → US6; developer C takes US4 then the Phase 9 observability and recovery work. T078 is the one cross-track dependency and should be sequenced after US1 lands.

---

## Notes

- **Tests are mandatory here, not optional** — Constitution VI is NON-NEGOTIABLE and T004 makes the 80% floor a build failure
- The four constitutionally required tests are T035, T068, T080 and T036
- Several tasks exist specifically because a design review found the first version wrong: T018's `WHEN` clause, T019's composite PK, T069's late delta, T081's decomposition, T083's limit reduction. Each carries the failure it prevents in its description — do not simplify those descriptions away
- [P] = different files, no dependencies on incomplete work
- Commit after each task or logical group
- Stop at any checkpoint to validate a story independently
