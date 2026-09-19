# Execution Plan: Phase 6 — Cancel a reservation that will never be funded (User Story 3, P2)

## Goal

`POST /v1/programs/{programId}/reservations/{invoiceId}/cancellation` returns **all** capacity still
tied to an invoice that will never be funded, recorded with a cause an auditor can tell apart from
repayment, and refuses a second cancellation as terminal. No reservation ever expires by the mere
passage of time.

## Preconditions

**Phases 3–5 are not merged as of this writing.** This plan is written against the state they leave
behind and must not be started before they are merged and green. Re-verify each fact below by
reading the repository; if any is false, stop.

- Phases 3–5 have landed: reserve, release, availability and the audit read model exist and are green.
- `LedgerCause` (`src/capacity/domain/ledger-entry.ts`) already includes `CANCELLATION` and
  `WRITE_OFF`. **No enum migration is required.**
- `reservation_status` already includes `CANCELLED` and `WRITTEN_OFF`.
- `advancePosition` remains the only writer of the position; `persistAdvance` the only writer of the
  program row; `UnitOfWork.withProgramLock` the only lock holder.
- Phase 4 introduced `ReservationSnapshot` in the domain layer and the
  `RESERVATION_TERMINAL` refusal; reuse both.
- The idempotency service and error filter from phase 3 are in place.

## Target State

- Cancelling an `ACTIVE` reservation appends `−outstanding_reserved_minor` on `LOCAL` with cause
  `CANCELLATION` and sets status `CANCELLED`.
- Cancelling a `PARTIALLY_RELEASED` reservation does the same with cause `WRITE_OFF` and status
  `WRITTEN_OFF` — the distinction is what tells an auditor that part of the invoice was actually
  repaid before the rest was abandoned (FR-025–027).
- A second cancellation, or a cancellation of a `FULLY_RELEASED` reservation, is refused
  `RESERVATION_TERMINAL` (409) and applies nothing.
- A fresh cancellation returns **201**; an idempotent replay returns **200** with the identical
  body (`contracts/http-api.yaml:209-217`) — the same split as release.
- No code path anywhere expires a reservation on elapsed time (FR-028).

## Scope

### In Scope

- `src/capacity/domain/policies/cancel.policy.ts` (T064)
- `src/capacity/application/cancel.service.ts` (T065)
- `src/capacity/api/dto/cancellation.dto.ts` (T066)
- The cancellation route on `CapacityController` (T067)
- Tests T062, T063

`contracts/http-api.yaml:222` **already declares 400** for `cancelReservation`. tasks.md T066's note
that it did not is stale; confirm and change nothing.

### Out of Scope

- Treasury ingestion, snapshots, the reconciliation job.
- Any change to release semantics or to `advancePosition`.
- Any scheduled or lazy expiry mechanism — its absence is a requirement, not an omission.

## Key Decisions

1. **The cause is chosen by what already happened to the reservation, not by the caller.**
   `ACTIVE` → `CANCELLATION`/`CANCELLED`; `PARTIALLY_RELEASED` → `WRITE_OFF`/`WRITTEN_OFF`. A caller
   cannot pick the cause, so the ledger cannot be made to lie about whether money came back.
2. **The delta is exactly `outstanding_reserved_minor`**, read under the lock — never recomputed
   from the invoice amount and the rate. Recomputing would drift from what releases actually applied.
3. **`reason` is a required enum on the body**, and its values are exactly
   `[CANCELLED, WRITTEN_OFF]` per `contracts/http-api.yaml:422-429`, with an optional `note` of
   `maxLength: 512`. The enum is what makes the cancellation queryable; the note is not a
   substitute for it. Do not add values — the enum is ratified.
4. **Terminal states are checked in the policy, not the controller**, so the rule is unit-testable
   without HTTP and cannot be bypassed by a future caller.
5. **The policy returns a positive magnitude; the service negates it.** `CancelDecision.deltaMinor`
   is the amount of capacity coming back, stated positive. The single ledger entry is
   `deltaMinor: -decision.deltaMinor`. Negating in both places double-counts; negating in neither
   adds capacity instead of returning it. Task 3's unit tests assert the sign of the policy output,
   and Task 5's integration test asserts the sign of the persisted entry.
6. **Repeat cancellation is idempotent per FR-027/FR-006** — the same `Idempotency-Key` replays the
   stored outcome; a *new* key against an already-terminal reservation is refused
   `RESERVATION_TERMINAL`. Those are different responses to different requests, and both are
   asserted.
7. **`WRITTEN_OFF` is terminal**, though FR-027's literal text names only "fully released or
   cancelled". `data-model.md`'s status diagram and the phase 4 plan both treat it as terminal; this
   plan resolves that spec ambiguity the same way rather than leaving it to the executor.
8. **FR-028 is proven by a test, not by absence.** T063 asserts no code path expires a reservation
   through elapsed time — a negative requirement that had no test before.

## Execution Order

### Task 1: `test/unit/no-auto-expiry.spec.ts` (T063) — WRITE FIRST

Prove FR-028 structurally, not by sampling behaviour:

- Grep-style assertion over `src/`: no scheduled job, cron decorator, `setTimeout`/`setInterval`, or
  TTL configuration targets `invoice_reservation`. Fail with the offending file and line.
- Behavioural assertion: build a `ReservationSnapshot` with a `confirmedAt` far in the past, run it
  through `releasePolicy` and `cancelPolicy` with a `now` far in the future, and assert neither
  status nor outstanding amounts change as a function of `now` alone.

Verification: the spec passes today and must keep passing; it is a regression guard.

### Task 2: `test/integration/cancellation.spec.ts` (T062) — WRITE FIRST, CONFIRM FAILING

Against Testcontainers:

- Cancel an `ACTIVE` reservation → **201**; all remaining capacity returns; ledger cause is `CANCELLATION`;
  status `CANCELLED`; `outstanding_reserved_minor = 0`; `program.local_reserved_minor` returns to
  its pre-reservation value.
- Reserve, release part, then cancel → cause `WRITE_OFF`, status `WRITTEN_OFF`, and the summed
  `LOCAL` deltas for that invoice are exactly zero.
- Cancel again → 409 `RESERVATION_TERMINAL`, and the ledger row count is unchanged.
- Cancel a `FULLY_RELEASED` reservation → 409 `RESERVATION_TERMINAL`.
- An auditor query filtering `cause = 'RELEASE'` does not return the cancellation entries.

### Task 3: The cancel policy (T064)

`src/capacity/domain/policies/cancel.policy.ts`, pure:

```ts
export type CancelRefusal = 'RESERVATION_TERMINAL';

export interface CancelDecision {
  readonly deltaMinor: bigint;                       // positive magnitude returned
  readonly cause: 'CANCELLATION' | 'WRITE_OFF';
  readonly status: 'CANCELLED' | 'WRITTEN_OFF';
}

export function cancelPolicy(
  reservation: ReservationSnapshot,
): Result<CancelDecision, CancelRefusal>;
```

Terminal statuses are `FULLY_RELEASED`, `CANCELLED`, `WRITTEN_OFF`.

Verification: unit tests for all five statuses; `npm run lint` clean.

### Task 4: The cancellation DTO (T066)

`src/capacity/api/dto/cancellation.dto.ts`: required `reason` enum — exactly `CANCELLED` and
`WRITTEN_OFF` — plus optional `note` at `maxLength: 512`, whitelist + `forbidNonWhitelisted`.
No OpenAPI edit: line 222 already declares 400.

Note the two namespaces do not coincide. The request's `reason` says which *outcome the caller is
asserting*; the **ledger cause** (`CANCELLATION` / `WRITE_OFF`) and the **status** are still derived
from the reservation's own state per Key Decision 1, never taken from the body. A caller sending
`reason: CANCELLED` for a `PARTIALLY_RELEASED` reservation still gets `WRITE_OFF` / `WRITTEN_OFF`.

### Task 5: The cancel service (T065)

`src/capacity/application/cancel.service.ts`, structured exactly like the phase 4 release service:
idempotency entry → `withProgramLock` → load the reservation `FOR UPDATE` → `cancelPolicy` → on
success `advancePosition` with a single negative `LOCAL` entry carrying the decided cause and
`originReference = invoiceId`, `persistAdvance`, then update the reservation row → return the
reservation view plus the availability projection. A refusal applies nothing.

### Task 6: The cancellation endpoint (T067)

`POST /v1/programs/:programId/reservations/:invoiceId/cancellation` on `CapacityController`,
`x-required-scope: capacity:write`, write throttler, `Idempotency-Key` required. Parameter spelling
`programId` exactly — any other spelling silently disables `ProgramScopeGuard`.

## Final Verification

```bash
docker compose down -v && docker compose up -d
npm run migration:run && npm run seed
npm run lint && npm run typecheck && npm test && npm run test:cov && npm run build
npm run audit:ledger
```

Manual check:

```bash
curl -i -X POST "$BASE/v1/programs/b1b2c3d4-0001-4000-8000-000000000011/reservations/INV-0002/cancellation" \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: cancel-0001" \
  -H "Content-Type: application/json" -d '{"reason":"CANCELLED","note":"invoice voided upstream"}'
```

Expected **`201`** with the availability restored; a repeat under the same key returns `200` with
the identical body; a repeat under a **new** key returns `409 RESERVATION_TERMINAL`.

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
