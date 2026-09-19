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
- **`program.reconciliation_pending` does not exist, and must not be created.** `data-model.md`'s
  `program` table enumerates every persisted column and has no such field; the same table marks the
  analogous `available_minor` "Derived, not stored". `reconciliationPending` is likewise **derived
  at read time** (see Key Decision 9). It is also the one flag `http-api.yaml:356` leaves out of
  the `Availability` `required` list.
- Two throttlers are registered globally (read 600/min, write 120/min) and **every route consumes
  both budgets**. `test/integration/auth.spec.ts` is the reference for the `ThrottlerStorage`
  override that test code uses to bypass them.

## Target State

- `GET /v1/programs/{programId}/availability` returns the `Availability` schema of
  `contracts/http-api.yaml:354-407` exactly: limit, reserved (total / local / treasury), **signed**
  available, over-limit state, `positionChangedAt`, the `treasury` object, and the health flags
  `positionVerified`, `investigationRequired` (both **required**) and `reconciliationPending`
  (optional).
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
- `docs/ASSUMPTIONS.md` entries: reads go to the primary; the FR-007a lag substitute

### Out of Scope

- Cancellation, treasury ingestion, snapshots.
- Any write path change.
- **Any schema change.** This phase adds no column and no migration.

## Key Decisions

1. **`available` is signed and never floored.** A negative figure is the honest over-limit magnitude;
   flooring at zero would conceal exactly what the over-limit state exists to surface (T056).
2. **Reads go to the primary.** FR-007b requires a client to see its own accepted change immediately;
   a read replica breaks that. This is recorded in `docs/ASSUMPTIONS.md` as a standing constraint,
   not left implicit in the connection config.
3. **⚠ FR-007a is NOT met by this phase, and that needs ratifying before execution.** FR-007a
   defines lag against the **newest message available on the stream**. Phase 5 has no stream
   reader, so it cannot compute that figure at all. The contract makes silence impossible:
   `treasury` is a **required** object whose own `required` list is `[appliedVersion, lagSeconds]`,
   with `lagSeconds` typed `number, minimum: 0` — **not nullable** (`http-api.yaml:398-406`). So
   this phase must emit *some* number while being unable to emit the right one.

   This plan does **not** get to decide that unilaterally — Executor Rule 8 forbids reinterpreting
   a product requirement. Two admissible resolutions, and someone with authority picks one before
   Task 4 starts:

   - **(A) Ship the substitute now.** `lagSeconds = max(0, (now − treasuryEffectiveAt)/1000)`, `0`
     when no treasury state has applied; phase 7 replaces it with the stream-head computation.
     FR-007a is knowingly unmet for the phase-5→7 window, recorded in `docs/ASSUMPTIONS.md`.
   - **(B) Re-sequence.** Move the `treasury` block of the availability response to phase 7 and
     amend the contract to make it optional until then, so nothing ever reports a figure FR-007a
     would call wrong.

   Until that call is made, treat this as a **stop-and-ask**, not an executor decision. The rest of
   the phase does not depend on it and can proceed.
4. **Availability reads take no row lock.** A plain `SELECT` of the program row is enough; the
   position columns are only ever written inside the locked transaction, so a committed read is
   consistent. Taking `FOR UPDATE` on a read path would serialise reads behind writes and fail SC-003.
5. **Paging is a cursor over `sequence DESC`, not `occurred_at`.** `sequence` is gapless and totally
   ordered per program, so the cursor is deterministic on ties; `occurred_at` is not unique and would
   skip or repeat rows (FR-031).
6. **The `treasury` object is never null, per the contract.** `appliedVersion` is
   `program.treasury_version` (`BIGINT NOT NULL DEFAULT 0`, so `0` before any treasury state — not
   null); `effectiveAt` is `program.treasury_effective_at` and **is** nullable; `lagSeconds` is a
   non-null `number >= 0` under resolution (A) above. Computing lag from `positionChangedAt`
   instead would report zero lag for a program treasury has never reached, which is the one answer
   that is definitely wrong.
7. **Three health flags are reported, not derived by the client.** All three come straight from the
   program row; the basis for exposing them on a read is **FR-019f** ("its finding MUST be visible …
   on the availability response"). FR-019e is the separate *write-refusal* rule for
   `positionVerified` and is phase 9's (T092). Phase 8 writes `investigation_required` and
   `reconciliation_pending`; until then both are `false`.
8. **`GET /ledger` requires `capacity:audit`** — declared by the contract itself at
   `http-api.yaml:239` (`x-required-scope: capacity:audit`), not derived from FR-017b. FR-017b is
   about separating *read* from *reserve/release/cancel*; the third audit scope is an additional
   contract-level distinction. Cite the contract for it, not the FR. The route lives on its own
   controller so the boundary is visible in the file layout.
9. **`reconciliationPending` is derived at read time, not stored.** True when the most recently
   applied snapshot acknowledged a reservation that has since been released — computable from
   `snapshot_acknowledgement` joined against the reservations' current status, with no new column
   and no writer. `data-model.md` already treats the sibling `available_minor` this way. Phase 8's
   T089 supplies the acknowledgement rows this reads; until then the predicate is simply false.

## Execution Order

### Task 1: `test/integration/read-your-writes.spec.ts` (T054) — WRITE FIRST

10,000 reserve-then-read trials against a Testcontainers stack; the caller's own accepted change is
visible in **100%** of them (SC-002). Assert on the returned `available` decreasing by the exact
reserved amount, not on a tolerance. Keep the trial amount at 1 minor unit so the program cannot go
over limit across the run.

**Override `ThrottlerStorage` exactly as `test/integration/auth.spec.ts` does.** At the registered
write budget of 120/min this spec would otherwise take over an hour and start returning 429 long
before trial 10,000 — the throttle, not the limit, is what breaks it. The override belongs to the
test harness only; the production guards stay registered.

Add to `docs/ASSUMPTIONS.md` in the same task: reads go to the primary, and — if resolution (A) was
ratified — that `lagSeconds` is a wall-clock substitute for FR-007a until phase 7 supplies the
stream head.

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
an over-limit program reports a negative value; `positionChangedAt` is ISO-8601; the `treasury`
object is **present and non-null** with `appliedVersion: 0` and a non-null `lagSeconds >= 0` before
any treasury state exists, and `effectiveAt: null` in that case; `positionVerified` and
`investigationRequired` are present booleans; `reconciliationPending` is a boolean when present;
403 without `capacity:read`; 404 for a foreign program. Validate the response against the
`Availability` schema rather than asserting field-by-field only.

### Task 4: The availability service (T057)

`src/capacity/application/availability.service.ts` returning a single readonly view matching the
`Availability` schema field for field. Pure assembly — no lock, no write. Use the domain helpers
`totalReserved`, `available`, `isOverLimit` rather than re-deriving arithmetic. Derive
`reconciliationPending` per Key Decision 9. Emit the `treasury` object per Key Decision 6, under
whichever FR-007a resolution was ratified.

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
