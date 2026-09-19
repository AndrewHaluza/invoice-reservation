# Execution Plan: Phase 5 — Read current availability and audit history (User Story 4, P1)

## Goal

A client reads a program's position and can judge how current it is; an outside auditor reproduces
that position from the API alone by summing ledger entries per component. Sequenced before US3/US5/US6
because it is P1 and because SC-004b is what proves the ledger design works at all.

## Preconditions

**Phases 3 and 4 are not merged as of this writing** — `src/capacity/api/` and
`src/capacity/application/` do not yet exist on `develop`. This plan is written against the state
those phases leave behind and must not be started before they are merged and green. Re-verify each
fact below by reading the repository; if any is false, stop.

- Phases 3 and 4 have landed: reserve and release both work, `CapacityController` exists,
  the availability projection built in phase 3 already computes limit / reserved / signed available
  for the write responses.
- `ProgramEntity` carries `creditLimitMinor`, `localReservedMinor`, `treasuryReservedMinor`,
  `nextSequence`, `overLimitSince`, `investigationRequired`, `positionVerified`,
  `positionChangedAt`. `ProgramRepository.toPosition` maps it to the domain `ProgramPosition`.
- `capacity_ledger_entry` carries `(program_id, sequence)` — gapless and totally ordered per program —
  plus `delta_minor`, `component`, `cause`, `origin_reference`, `actor`, `correlation_id`,
  `occurred_at`. `LedgerRepository.sumByComponent` already returns `{ LOCAL, TREASURY, LIMIT }`.
- `program_stream_position` exists but nothing writes it yet; treasury applied version and effective
  time therefore have **no source until phase 7**.
- `ProgramScopeGuard` resolves ownership only from a route parameter named exactly `programId`.
- Layer rule: `api → application | domain | shared`. A controller must not touch a repository.
- **`program.reconciliation_pending` does not exist.** No phase up to here creates it, and phase 8
  (T089) is what gives it a writer. Task 0 below adds the column so this phase can report it.
- Two throttlers are registered globally (read 600/min, write 120/min) and **every route consumes
  both budgets**. `test/integration/auth.spec.ts` is the reference for the `ThrottlerStorage`
  override that test code uses to bypass them.

## Target State

- `GET /v1/programs/{programId}/availability` returns limit, reserved (total / local / treasury),
  **signed** available, over-limit state, `positionChangedAt`, treasury applied version, treasury
  effective time, `lagSeconds`, and the three health flags `positionVerified`,
  `investigationRequired`, `reconciliationPending`.
- `GET …/reservations`, `GET …/reservations/{invoiceId}`, `GET …/ledger` serve the audit path.
- Summing the ledger per component reproduces `local_reserved_minor`, `treasury_reserved_minor`
  **and `credit_limit_minor`** exactly, so `available` is fully reconstructible from the audit API.

## Scope

### In Scope

- `src/capacity/application/availability.service.ts` (T057)
- `src/capacity/application/audit-read.service.ts` (T058)
- Read routes on `CapacityController` (T059) and a new `src/capacity/api/audit.controller.ts` (T060)
- `scripts/audit-ledger.ts` + `npm run audit:ledger` (T061)
- Tests T054, T055, T056
- `docs/ASSUMPTIONS.md` entry: reads go to the primary

### Out of Scope

- Cancellation, treasury ingestion, snapshots. Where a field has no source yet (treasury applied
  version, effective time), the service returns `null` and `lagSeconds: null` — it does **not**
  invent a value and does **not** omit the field.
- Any write path change.

## Key Decisions

1. **`available` is signed and never floored.** A negative figure is the honest over-limit magnitude;
   flooring at zero would conceal exactly what the over-limit state exists to surface (T056).
2. **Reads go to the primary.** FR-007b requires a client to see its own accepted change immediately;
   a read replica breaks that. This is recorded in `docs/ASSUMPTIONS.md` as a standing constraint,
   not left implicit in the connection config.
3. **`lagSeconds` here is an approximation, and phase 7 must revisit it.** FR-007a defines lag
   against the **newest message available on the stream**; phase 5 has no stream reader, so this
   phase computes it against wall-clock `now` (Key Decision 5). That satisfies the field's shape,
   not FR-007a's letter. Record the gap in `docs/ASSUMPTIONS.md` and re-derive it in phase 7 once
   the consumer knows the stream head.
4. **Availability reads take no row lock.** A plain `SELECT` of the program row is enough; the
   position columns are only ever written inside the locked transaction, so a committed read is
   consistent. Taking `FOR UPDATE` on a read path would serialise reads behind writes and fail SC-003.
5. **Paging is a cursor over `sequence DESC`, not `occurred_at`.** `sequence` is gapless and totally
   ordered per program, so the cursor is deterministic on ties; `occurred_at` is not unique and would
   skip or repeat rows (FR-031).
6. **`lagSeconds` is computed from the treasury effective time**, not from `positionChangedAt`:
   `lagSeconds = (now − treasuryEffectiveAt) / 1000`, `null` when no treasury state has ever applied.
   Using the local change time would report zero lag for a program treasury has never reached.
7. **Three health flags are reported, not derived by the client.** All three come straight from the
   program row; the basis for exposing them on a read is **FR-019f** ("its finding MUST be visible …
   on the availability response"). FR-019e is the separate *write-refusal* rule for
   `positionVerified` and is phase 9's (T092). Phase 8 writes `investigation_required` and
   `reconciliation_pending`; until then both are `false`.
8. **`GET /ledger` requires `capacity:audit`**, distinct from `capacity:read` (FR-017b). It lives on
   its own controller so the scope boundary is visible in the file layout.

## Execution Order

### Task 0: Add the `reconciliation_pending` column

A migration adding `program.reconciliation_pending boolean NOT NULL DEFAULT false`, the matching
field on `ProgramEntity`, and `reconciliationPending` on the domain `ProgramPosition` /
`ProgramRepository.toPosition`. Generate it with
`npm run migration:generate -- src/migrations/AddReconciliationPending`; run migrations as the
owning `capacity` role via `MIGRATION_DATABASE_URL`, never as `capacity_app`.

This phase only **reports** the flag — no code here writes it. Its writer is phase 8's T089.

Verification: `npm run migration:run && npm run migration:revert && npm run migration:run` is clean;
`npm run typecheck` passes.

### Task 1: `test/integration/read-your-writes.spec.ts` (T054) — WRITE FIRST

10,000 reserve-then-read trials against a Testcontainers stack; the caller's own accepted change is
visible in **100%** of them (SC-002). Assert on the returned `available` decreasing by the exact
reserved amount, not on a tolerance. Keep the trial amount at 1 minor unit so the program cannot go
over limit across the run.

**Override `ThrottlerStorage` exactly as `test/integration/auth.spec.ts` does.** At the registered
write budget of 120/min this spec would otherwise take over an hour and start returning 429 long
before trial 10,000 — the throttle, not the limit, is what breaks it. The override belongs to the
test harness only; the production guards stay registered.

Add to `docs/ASSUMPTIONS.md` in the same task: reads go to the primary, and `lagSeconds` is a
wall-clock approximation of FR-007a until phase 7 supplies the stream head.

Verification: the spec fails today only if the endpoint is missing — confirm that failure mode before
writing the implementation.

### Task 2: `test/integration/ledger-audit.spec.ts` (T055) — WRITE FIRST

Reserve, partially release, and (where phase 4 allows) drive the position through several changes,
then assert that `SUM(delta_minor) GROUP BY component` reproduces **all three** of
`local_reserved_minor`, `treasury_reserved_minor` and `credit_limit_minor` (SC-004b, FR-019a).
Include one program whose limit was set at seed time, to prove the limit's opening balance is itself
a ledger entry rather than a column written behind the ledger's back. **If it is not, that is a
defect in the phase 2 migration or seed — stop and report it; do not paper over it in the test.**

### Task 3: `test/contract/availability.contract.spec.ts` (T056) — WRITE FIRST

Assert the response shape field by field, including: `available.amountMinor` is a **signed** string;
an over-limit program reports a negative value; `positionChangedAt` is ISO-8601;
`treasuryAppliedVersion` and `treasuryEffectiveAt` are `null` before any treasury state exists and
the field is still present; `lagSeconds` is `null` in that case; the three health flags are booleans;
403 without `capacity:read`; 404 for a foreign program.

### Task 4: The availability service (T057)

`src/capacity/application/availability.service.ts` returning a single readonly view object built from
`ProgramPosition` plus the stream-position row when it exists. Pure assembly — no lock, no write.
Use the domain helpers `totalReserved`, `available`, `isOverLimit` rather than re-deriving arithmetic.

Verification: `npx jest test/contract/availability.contract.spec.ts` passes once Task 6 wires the
route; `npm run lint` clean.

### Task 5: The audit read service (T058)

`src/capacity/application/audit-read.service.ts`:

- `listReservations(programId, { status?, cursor?, limit })` — page on **`(created_at DESC, id DESC)`**
  with the cursor carrying both parts. `created_at` alone is not unique; the `id` tiebreak is what
  makes the page deterministic. This is a decision, not a choice for the executor.
- `getReservation(programId, invoiceId)`.
- `listLedger(programId, { from?, to?, cause?, cursor?, limit })` — **`ORDER BY sequence DESC`**, the
  cursor is the last `sequence` seen, `limit` bounded (default 100, max 1000) and validated.

Every query is parameterised. Never interpolate a cursor or filter into SQL text.

### Task 6: The read routes (T059)

On `CapacityController`, with `x-required-scope: capacity:read` and the read throttler:

- `GET /v1/programs/:programId/availability`
- `GET /v1/programs/:programId/reservations`
- `GET /v1/programs/:programId/reservations/:invoiceId`

Parameter spelling `programId` exactly (see Current State).

### Task 7: The ledger route (T060)

`src/capacity/api/audit.controller.ts`: `GET /v1/programs/:programId/ledger` with time-range and
cause filtering, `x-required-scope: capacity:audit`. A caller holding only `capacity:read` gets 403 —
assert this in the contract spec.

### Task 8: `scripts/audit-ledger.ts` (T061)

Replays every program's ledger and asserts per-component equality with the cached position; exits
non-zero on the first mismatch, printing program id, component, ledger sum and cached value. Wire as
`npm run audit:ledger` in `package.json` (SC-004). The script reports; it **never self-corrects**.

Verification: run it against the seeded database — it exits 0.

## Final Verification

```bash
docker compose down -v && docker compose up -d
npm run migration:run && npm run seed
npm run lint && npm run typecheck && npm test && npm run test:cov && npm run build
npm run audit:ledger
```

Manual check:

```bash
curl -s "$BASE/v1/programs/b1b2c3d4-0001-4000-8000-000000000011/availability" \
  -H "Authorization: Bearer $TOKEN" | jq
```

Expected: `available` present and signed; `treasuryAppliedVersion` and `treasuryEffectiveAt` `null`;
`lagSeconds` `null`; `positionVerified` `true`.

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

When stopping, report: the task number, the exact blocker, the evidence establishing it, which plan
assumption is invalid, and the minimum planning decision required to continue.
