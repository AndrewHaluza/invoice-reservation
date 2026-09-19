# Execution Plan: Phase 7 — Apply treasury capacity updates from the event stream (User Story 5, P2)

## Goal

Incremental treasury changes reach a program's position **exactly once**, in any order, without this
service's own bookings being double-counted, and without a message that cannot apply being lost in
silence. A transient failure is retried in place and never reaches the DLQ; a permanently
inapplicable message is quarantined with a reason.

## Preconditions

**Phases 3–6 are not merged as of this writing.** This plan is written against the state they leave
behind. Re-verify each fact below by reading the repository; if any is false, stop.

- Phases 3–6 have landed. The HTTP write paths, the availability read and the audit read exist.
- `src/treasury/` **does not exist yet**, but the boundaries matrix is **already correct**:
  `eslint.config.mjs:37` declares `{ type: 'treasury', pattern: 'src/treasury/**' }` and line 55
  grants `{ from: 'treasury', allow: ['application', 'shared', 'config', 'observability'] }`.
  **No matrix change is required by this phase.** Widening it further is a stop-and-re-plan
  condition.
- `src/config/env.schema.ts` **already defines** `KAFKA_BROKERS`, `KAFKA_SASL_USERNAME`,
  `KAFKA_SASL_PASSWORD`, `KAFKA_CAPACITY_EVENTS_TOPIC`, `KAFKA_SNAPSHOTS_TOPIC`, `KAFKA_DLQ_TOPIC`
  and `SNAPSHOT_DELTA_GUARD_RATIO` (the FR-032 proportion). Only a **consumer group id** and the
  **retry bounds** are missing.
- Two stream-position entities coexist: `stream-position.entity.ts` (table `stream_position`, PK
  `(topic, partition)` — global, a leftover from an earlier design) and
  `program-stream-position.entity.ts` (table `program_stream_position`, PK
  `(program_id, topic, partition)`). **This phase uses `ProgramStreamPositionEntity` only**; FR-019d
  is per-program and the global table cannot express it. Do not touch `stream_position`.
- `processed_message` exists: PK `message_id`, plus `program_id`, `kind ('EVENT'|'SNAPSHOT')`,
  `version`, `content_hash`, `processed_at`. `content_hash` is what makes FR-013b's
  same-version-different-content detection possible.
- `invoice_reservation.treasury_reference` and `treasury_acknowledged` exist and are unused so far.
- `KAFKA_BROKERS` in `.env.example` uses the **SASL port 9093**, not 9092. Ports are per-worktree —
  read them from `./scripts/dev-stack.sh env`, never hardcode.
- Env vars are validated at boot by joi (`src/config/env.schema.ts`); a new var must be added there
  **and** to `.env.example`, which `scripts/verify-uat.sh` asserts match exactly.
- `AppModule` has no consumer wiring; the process today is HTTP-only.

## Target State

- A KafkaJS consumer with `autoCommit: false` commits an offset **only after** the handling
  transaction has committed.
- `RESERVATION_BOOKED` / `RESERVATION_RELEASED` apply to the `TREASURY` component;
  `LIMIT_CHANGED` applies to the `LIMIT` component as a **signed difference**, never as a direct write.
- An event naming a reservation this service originated is skipped (echo suppression, FR-010a).
- An event whose version is **below** the applied snapshot version still applies (FR-012a).
- Every quarantine carries a reason. **This phase implements the event-path reasons only:**
  `SCHEMA_INVALID`, `UNKNOWN_PROGRAM`, `CURRENCY_MISMATCH`, `VERSION_CONFLICT`, `HANDLER_FAILURE`.
  `MISSING_ACK_MARKER` and `IMPLAUSIBLE_DELTA` are **snapshot-only** and belong to phase 8 — the DLQ
  mechanism here must simply accept any reason string, so phase 8 adds no plumbing.

## Scope

### In Scope

- `src/treasury/consumer/`, `src/treasury/schemas/`, `src/treasury/retry/`, `src/treasury/dlq/`,
  `src/treasury/handlers/capacity-event.handler.ts` (T072–T076)
- `src/capacity/application/apply-treasury-event.service.ts` (T077, T078)
- `src/capacity/infrastructure/repositories/program-stream-position.repository.ts` (T079)
- Tests T068–T071
- The four missing consumer env vars (the boundaries matrix already allows `treasury`)

### Out of Scope

- Reconciliation snapshots (phase 8) — the snapshot handler is phase 8's, though it shares this
  phase's consumer, dedupe and DLQ.
- The scheduled reconciliation check and recovery detection (phase 9).
- Kafka topic ACLs (T097, phase 9).

## Key Decisions

1. **Offset commit follows the database commit, never precedes it.** With `autoCommit: false` the
   only durable record that a message was applied is `processed_message`, written **in the same
   transaction** as the ledger entry. A crash between the two commits replays the message, and the
   dedupe absorbs it. The reverse order loses the effect permanently.
2. **The handler parses, validates, dedupes and dispatches. It must not open a transaction or write
   the aggregate.** That is plan.md's second dependency rule; the application service owns the
   transaction and the row lock.
3. **Dedupe by message identity first, version second (FR-013a).** A byte-identical redelivery is
   suppressed before any version arithmetic runs, so a replay can never be mistaken for a conflict.
4. **An incremental event is never discarded for being old (FR-012a).** Only *snapshots* have
   version precedence. Discarding a late delta loses capacity permanently with no quarantine and no
   alert — SC-009 violated by design rather than by bug. T069 exists to keep this honest.
5. **Echo suppression matches `payload.reservationReference` against
   `invoice_reservation.treasury_reference`.** Without it the same reservation is counted once as
   `LOCAL` and again as `TREASURY`, and the program silently loses that much capacity twice over.
6. **Transient vs permanent is an explicit classification, not a catch-all.** Connection loss, pool
   exhaustion, lock timeout and serialization failure are transient: retried with bounded
   exponential backoff, offset **not** committed, DLQ **not** used. Only a message that can never
   apply may be quarantined (FR-035).
7. **`LIMIT_CHANGED` is applied as a difference.** The ledger must remain summable to the cached
   position (SC-004b, FR-019a); writing an absolute limit would break the invariant that every
   reported figure is reconstructible from entries.
8. **The consumer shares a process with the HTTP server.** This is a deliberate phase-7 trade-off:
   scaling triggers a rebalance that pauses ingestion, mitigated by cooperative-sticky assignment.
   Record it in `docs/ASSUMPTIONS.md`.

## Execution Order

### Task 1: Config and module skeleton

- **Do not touch `eslint.config.mjs`.** The `treasury` row already grants
  `application | shared | config | observability`; `treasury → domain` is deliberately absent — the
  aggregate is reached through the application service. Needing a wider row is a re-plan trigger,
  not an edit.
- Add only the **missing** env vars to `src/config/env.schema.ts` **and** `.env.example`:
  `KAFKA_CONSUMER_GROUP_ID`, `KAFKA_RETRY_MAX_ATTEMPTS`, `KAFKA_RETRY_BASE_DELAY_MS`,
  `KAFKA_RETRY_MAX_DELAY_MS`. The Kafka broker, SASL, topic and `SNAPSHOT_DELTA_GUARD_RATIO` vars
  already exist — re-declaring them breaks boot validation.
- Create `src/treasury/treasury.module.ts`, not yet imported by `AppModule`.

Verification: `npm run lint && npm run typecheck`; `bash scripts/verify-uat.sh` still passes the
`.env.example` ↔ schema equality assertion.

### Task 2: `test/integration/idempotency.spec.ts` (T068) — MANDATORY (Constitution VI), WRITE FIRST

- Duplicate delivery of the same message changes the position exactly once.
- Two organisations reusing the same `Idempotency-Key` neither collide nor replay one another's
  outcome (FR-006d) — the HTTP half of the same guarantee.
- A reused key with different content is `IDEMPOTENCY_CONFLICT` (SC-005).

### Task 3: `test/integration/late-delta.spec.ts` (T069) — WRITE FIRST

An incremental event whose version is below the applied snapshot version **still applies**, exactly
once. Assert both the position change and the absence of any DLQ record.

### Task 4: `test/integration/echo-suppression.spec.ts` (T070) — WRITE FIRST

An event whose `reservationReference` names a reservation this service originated is skipped:
`TREASURY` unchanged, `LOCAL` unchanged, `processed_message` written (so the skip is durable and the
message is not reprocessed), and no ledger entry appended.

### Task 5: `test/integration/dlq.spec.ts` (T071) — WRITE FIRST

One case per **event-path** quarantine reason: `SCHEMA_INVALID`, `UNKNOWN_PROGRAM`,
`CURRENCY_MISMATCH`, `VERSION_CONFLICT`, `HANDLER_FAILURE`. Plus the negative case that matters most:
a **transient** failure (simulate a lock timeout) is retried in place, never reaches the DLQ, and the
offset is not committed until it eventually succeeds.

`MISSING_ACK_MARKER` and `IMPLAUSIBLE_DELTA` are snapshot-only. Add them to this spec as
`it.todo(...)` entries referencing phase 8, so the coverage gap is visible rather than forgotten.
Writing them here would require the snapshot handler this plan puts out of scope.

### Task 6: Schema validation (T073)

`src/treasury/schemas/` mirroring `contracts/*.json`, including the **bounded-digit check** so a
40-digit amount string is rejected before it can overflow `BIGINT`. Validation failure →
`SCHEMA_INVALID`, permanent.

### Task 7: Failure classification and retry (T074)

`src/treasury/retry/`: an explicit predicate mapping error shapes to `TRANSIENT | PERMANENT`, and a
bounded exponential backoff. Unknown errors classify as **transient and bounded** — after the bound
is exhausted they become `HANDLER_FAILURE` and quarantine. An unknown error must never be treated as
permanent on first sight.

### Task 8: The DLQ publisher (T075)

`src/treasury/dlq/` republishes the original message bytes to `treasury.capacity.dlq` with headers:
reason, correlation id, original topic, partition and offset. The consumer commits the offset **only
after** the DLQ publish succeeds; a failed publish is itself transient and retried.

### Task 9: The consumer (T072)

Commit sequence per message, both paths:

- **Applied:** handle → database transaction commits (ledger + `processed_message` +
  `program_stream_position`) → `commitOffsets`.
- **Quarantined:** write the `processed_message` row recording the quarantine decision and commit
  that transaction → publish to the DLQ → `commitOffsets`. A failed DLQ publish is transient: retry,
  and do not commit the offset.
- **Transient failure:** retry in place, no offset commit, no DLQ.


`src/treasury/consumer/`: KafkaJS, `autoCommit: false`, SASL_SSL/mTLS per research R4/R11,
cooperative-sticky partition assignment, graceful shutdown wired to the Nest shutdown hooks that
phase 3 registered. Commit sequence per message: handle → (DB commit) → `commitOffsets`.

### Task 10: The event handler (T076)

`src/treasury/handlers/capacity-event.handler.ts`: parse → validate → dedupe by message identity →
**version/content comparison** → dispatch to the application service. **No transaction, no aggregate
write.** Unknown program → `UNKNOWN_PROGRAM`; currency mismatch against the program's immutable
denomination currency → `CURRENCY_MISMATCH` (FR-013c, FR-013d).

**`VERSION_CONFLICT` (FR-013b), explicitly:** compute a stable content hash of the message payload.
Look up `processed_message` by `message_id` first (FR-013a — identity wins). On no identity match,
look for an already-applied row for the same `(program_id, kind, version)`; if one exists and its
`content_hash` differs, quarantine `VERSION_CONFLICT`. Equal version **and** equal hash is a replay
under a different message id — treat it as already applied, not as a conflict. The same rule applies
to a message whose effective time equals the applied state with differing content.

### Task 11: The apply service (T077, T078)

`src/capacity/application/apply-treasury-event.service.ts`:

1. `withProgramLock(programId, …)`.
2. Insert `processed_message` **in the same transaction**; a unique-violation on `message_id` means
   an already-applied message — commit nothing further and report success (idempotent).
3. Echo suppression: if `payload.reservationReference` matches an `invoice_reservation.treasury_reference`
   for this program, mark `treasury_acknowledged` and stop before appending an entry (T078).
4. Build the pending entry: `RESERVATION_BOOKED` → `+amount` on `TREASURY`; `RESERVATION_RELEASED` →
   `−amount` on `TREASURY`; `LIMIT_CHANGED` → `newLimit − program.creditLimitMinor` on `LIMIT`.
5. `advancePosition` → `persistAdvance`.
6. Write `program_stream_position` in the same transaction (Task 12).

### Task 12: The stream-position repository (T079)

`src/capacity/infrastructure/repositories/program-stream-position.repository.ts`, backed by
**`ProgramStreamPositionEntity`** (never `StreamPositionEntity`), upserting
`(program_id, topic, partition) → offset, updated_at` inside the handling transaction (FR-019d).
This row is what phase 9's recovery detection reads; a position written outside the transaction
would claim progress the ledger does not have.

### Task 13: Record the process-topology assumption

Append to `docs/ASSUMPTIONS.md` (created in phase 5): the consumer shares a process with the HTTP
server, so scaling triggers a rebalance that pauses ingestion, mitigated by cooperative-sticky
assignment; and the treasury producer's partitioning key is unratified, affecting throughput but not
correctness. Also revisit the `lagSeconds` approximation phase 5 recorded — the consumer now knows
the stream head, so FR-007a can be computed properly; if that is deferred, say so in the file.

## Final Verification

```bash
./scripts/dev-stack.sh env          # resolve this worktree's ports; never hardcode 9092
docker compose down -v && docker compose up -d
npm run migration:run && npm run seed
npm run lint && npm run typecheck && npm test && npm run test:cov && npm run build
npm run audit:ledger
```

Expected: `eslint.config.mjs` is **unchanged**; every event-path DLQ reason has a passing test and
the two snapshot-only reasons are `it.todo`; the late-delta and echo-suppression specs pass; coverage holds 80%.

Manual check: publish one `RESERVATION_BOOKED` to the events topic, read
`GET …/availability` and see `reserved.treasury` move; republish the identical bytes and see nothing
change.

## Executor Rules

1. Execute each task in a **separate sub-agent** with a fresh context.
2. Execute tasks strictly in numerical order.
3. Complete the current task and its verification before starting the next.
4. Implement the solution described in the plan exactly.
5. Do not redesign architecture or substitute a different approach.
6. Do not add features, cleanup, abstractions, or refactors the plan does not require.
7. Do not omit planned behavior because another implementation appears simpler.
8. Do not reinterpret product requirements.
9. Do not make optional improvements.
10. Follow existing project conventions where the plan explicitly relies on them.
11. Run the verification specified for every task.
12. Mark a task complete only when its completion criteria are satisfied.
13. If implementation reveals information that does not affect the prescribed solution, continue.
14. Stop rather than improvise when the plan cannot be executed as written.

Widening the boundaries matrix at all is a **stop-and-re-plan** condition, not an executor decision. When stopping, report: the task number, the exact blocker, the evidence,
the invalid assumption, and the minimum planning decision required to continue.
