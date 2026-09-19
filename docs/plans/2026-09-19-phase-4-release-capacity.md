# Execution Plan: Phase 4 — Release capacity when an invoice is repaid (User Story 2, P1)

## Goal

`POST /v1/programs/{programId}/reservations/{invoiceId}/releases` accepts a repayment denominated
in the **invoice's** currency, converts it at the rate **fixed on the reservation at reserve time**,
appends a `−Δ` `LOCAL` ledger entry with cause `RELEASE` under the program row lock, and drives the
reservation through `PARTIALLY_RELEASED` → `FULLY_RELEASED` so that a fully repaid invoice nets to
exactly zero with no stranded minor units.

## Preconditions

**Phase 3 is not merged as of this writing** — `src/capacity/api/` and `src/capacity/application/`
do not exist on `develop`; phase 3 lives only as a plan plus the branch
`karst/feat/feat-3-phase-3-reserve-capacity-…`. This plan is written against the state phase 3
leaves behind and **must not be started until phase 3 is merged and green**. Re-verify each fact
below by reading the repository; if any is false, stop (Executor Rules).

- Phase 3 has landed: `src/capacity/api/capacity.controller.ts`,
  `src/capacity/application/reserve.service.ts`,
  `src/capacity/domain/policies/reserve.policy.ts`, the idempotency service, the availability
  projection, the shared validation pipe and the error filter all exist and are green.
- `advancePosition(program, entries, now)` (`src/capacity/domain/position.ts`) is the only writer of
  the position; it assigns per-program sequences and appends the zero-delta `OVER_LIMIT_ONSET` /
  `OVER_LIMIT_CLEARED` entry when the state flips. `ProgramRepository.persistAdvance` is the only
  writer of the `program` row.
- `UnitOfWork.withProgramLock(programId, fn)` opens a `READ COMMITTED` transaction, takes
  `SELECT … FOR UPDATE` on the program, and hands `fn` `{ manager, program }`.
- `InvoiceReservationEntity` already carries `invoiceAmountMinor`, `invoiceCurrency`,
  `programCurrency`, `reservedMinor`, `outstandingInvoiceMinor`, `outstandingReservedMinor`,
  `fxRate` (`numeric(20,10)`, nullable), `fxRateEffectiveAt`, `fxRateSource`, `status`, `origin`.
  **No new table and no new column is required by this phase.**
- `convert(amount, targetCurrency, scaledRate)` and `scaleRate(rateString)` live in
  `src/shared/money/convert.ts`; `roundHalfUp` rounds away from zero on a tie in both directions.
- Errors are `Result` in domain/application (`src/shared/result/`); exceptions only at the edge,
  mapped by the phase 3 error filter.
- `contracts/errors.md:20` and `contracts/http-api.yaml` (release endpoint) **already agree**:
  `CURRENCY_MISMATCH` is 409. tasks.md T049's note that they disagreed is stale; the contract test
  asserts 409 and no document needs changing. If a disagreement has reappeared, 409 is the ratified
  answer and the other document changes.
- `contracts/http-api.yaml` (release endpoint, ~line 162) declares **`201` for a release** and
  `200` for an idempotent replay — the same split as the reservation endpoint.

## Target State

- A release of the invoice's full remaining amount leaves `outstanding_invoice_minor = 0` **and**
  `outstanding_reserved_minor = 0`, status `FULLY_RELEASED`, and the summed `LOCAL` ledger deltas
  for that reservation exactly zero.
- A release larger than what is still reserved is **refused**, never clamped.
- A release in any currency other than the invoice's own is refused `CURRENCY_MISMATCH` (409).
- A fresh release returns **201**; an idempotent replay of the same key and content returns **200**
  with the identical body (per `contracts/http-api.yaml`).
- Releases are idempotent on `Idempotency-Key` through the existing `request_record` scheme.

## Scope

### In Scope

- `src/capacity/domain/policies/release.policy.ts` (T050)
- `src/capacity/application/release.service.ts` (T051)
- `src/capacity/api/dto/create-release.dto.ts` (T052)
- The release route on the existing `CapacityController` (T053)
- Tests T047, T048, T049

### Out of Scope

- Cancellation (phase 6), treasury ingestion (phases 7–8), the audit read model (phase 5).
- Any change to `advancePosition`, to the migration, or to the FX provider.
- Any new idempotency mechanism — reuse `request_record`.

## Key Decisions

1. **The rate is read from the reservation row, never re-quoted.** FR-009: a release uses the rate
   recorded on the reservation. Re-quoting at release time would let FX drift strand minor units and
   break SC-004a.
2. **The over-release check runs on the pre-snap Δ.** Order is: compute
   `Δ = round_half_up(R × rate)`; if `Δ > outstanding_reserved_minor` → `RELEASE_EXCEEDS_RESERVED`;
   **then** snap. Checking after the snap would silently clamp an over-release, which
   Constitution III forbids.
3. **Snap conditions (FR-009b).** `Δ := outstanding_reserved_minor` when either
   `R === outstanding_invoice_minor` (the invoice is fully repaid) or
   `outstanding_reserved_minor − Δ < 1` (rounding would strand sub-unit dust).
4. **Release amount is in the invoice's currency only.** Even when invoice and program currency
   agree, the field is validated against `invoiceCurrency`, so the rule has one code path.
5. **Δ is applied as a single negative `LOCAL` entry** with cause `RELEASE` and
   `originReference = invoiceId`. The `TREASURY` component is untouched — treasury's own view of the
   release arrives on the stream (phase 7) and is echo-suppressed there.
6. **Status transition is derived, not passed in**: `outstanding_invoice_minor === 0n` →
   `FULLY_RELEASED`, otherwise `PARTIALLY_RELEASED`. A reservation already in a terminal status
   (`FULLY_RELEASED`, `CANCELLED`, `WRITTEN_OFF`) is refused `RESERVATION_TERMINAL` (409).

## Execution Order

### Task 1: `test/unit/release-policy.spec.ts` (T047) — WRITE FIRST, CONFIRM FAILING

Pure-function tests against the not-yet-existing `releasePolicy`. Cases, at minimum:

- `R` equal to the full outstanding invoice amount → `Δ === outstanding_reserved_minor` exactly,
  even when `round_half_up(R × rate)` differs by a minor unit.
- `Δ` greater than `outstanding_reserved_minor` **before** any snap → `err('RELEASE_EXCEEDS_RESERVED')`;
  assert the returned value is an error, not a clamped success.
- `outstanding_reserved_minor − Δ === 0n` boundary: not an error, snapped.
- Partial release leaving a remainder → both outstandings decrease by their respective amounts.
- A release currency that is not `invoiceCurrency` → `err('CURRENCY_MISMATCH')`.
- A zero or negative `R` → `err('INVALID_AMOUNT')`.
- A reservation in each terminal status → `err('RESERVATION_TERMINAL')`.
- **The ordering trap, explicitly:** `outstanding_reserved_minor − Δ < 1` is true for *every* Δ
  greater than `outstanding_reserved_minor`, not only for rounding dust. Include a case where Δ
  exceeds `outstanding_reserved_minor` by exactly one minor unit and assert
  `RELEASE_EXCEEDS_RESERVED` — if the snap is evaluated first, that case silently clamps and the
  test is the only thing that catches it.

Verification: `npx jest test/unit/release-policy.spec.ts` fails to resolve the module.

### Task 2: The release policy (T050)

`src/capacity/domain/policies/release.policy.ts` — pure, no NestJS, no I/O. Domain layer may import
only `domain` and `shared`, or lint fails.

```ts
export interface ReleaseInput {
  readonly releaseMinor: bigint;
  readonly releaseCurrency: string;
  readonly reservation: ReservationSnapshot; // readonly domain view, not the TypeORM entity
  readonly scaledRate: bigint;               // scaleRate(reservation.fxRate ?? '1.0')
}

export type ReleaseRefusal =
  | 'INVALID_AMOUNT'
  | 'CURRENCY_MISMATCH'
  | 'RESERVATION_TERMINAL'
  | 'RELEASE_EXCEEDS_RESERVED';

export interface ReleaseDecision {
  readonly deltaMinor: bigint;                 // positive magnitude of capacity returned
  readonly outstandingInvoiceMinor: bigint;
  readonly outstandingReservedMinor: bigint;
  readonly status: 'PARTIALLY_RELEASED' | 'FULLY_RELEASED';
}

export function releasePolicy(input: ReleaseInput): Result<ReleaseDecision, ReleaseRefusal>;
```

The order of checks inside the function is the order in Key Decision 2. Declare `ReservationSnapshot`
in the domain layer so the policy never imports an infrastructure entity.

Verification: `npx jest test/unit/release-policy.spec.ts` passes; `npm run lint` reports no
`boundaries/dependencies` violation.

### Task 3: The release DTO (T052)

`src/capacity/api/dto/create-release.dto.ts`, mirroring the phase 3 create-reservation DTO exactly:
bounded-digit amount string (rejected before it can overflow `BIGINT`), ISO-4217 currency pattern,
whitelist + `forbidNonWhitelisted` through the shared validation pipe. No new pipe.

Verification: `npm run typecheck`; a malformed body returns 400 from the existing filter.

### Task 4: The release service (T051)

`src/capacity/application/release.service.ts`. Responsibilities, in order:

1. Enter the existing idempotency service with the request's `Idempotency-Key` and content
   fingerprint (`PENDING` recorded before the effect — FR-006e). A replay returns the stored outcome.
2. `unitOfWork.withProgramLock(programId, async ({ manager, program }) => …)`.
3. Load the reservation `FOR UPDATE` by `(program_id, invoice_id)` inside the same transaction;
   absent → `RESERVATION_NOT_FOUND` (404).
4. `scaleRate(reservation.fxRate ?? '1.0')`; call `releasePolicy`.
5. On refusal, return the typed error and **apply nothing** — no ledger entry, no row update — then
   record the terminal outcome against the request record.
6. On success, `advancePosition(program, [{ deltaMinor: -decision.deltaMinor, component: 'LOCAL',
   cause: 'RELEASE', originReference: invoiceId, actor, correlationId }], now)`, then
   `programRepository.persistAdvance(...)`, then `UPDATE invoice_reservation` with the new
   outstandings, status and `updated_at`.
7. Return the reservation view plus the availability projection built in phase 3.

The service owns the transaction; the controller must not.

Verification: `npm run typecheck && npm run lint`.

### Task 5: `test/integration/release-nets-to-zero.spec.ts` (T048)

Testcontainers Postgres via `test/support/postgres-container.ts` (the app connects as the non-owner
`capacity_app` role). Scenario, from SC-004a:

- Program: Northwind USD, `b1b2c3d4-0001-4000-8000-000000000011`.
- Reserve an invoice of `33333` EUR at seeded rate `1.0850000000` → `reserved_minor = 36166`.
- Release `20000` EUR, then `13333` EUR.
- Assert: status `FULLY_RELEASED`; `outstanding_invoice_minor = 0`; `outstanding_reserved_minor = 0`;
  `SUM(delta_minor) WHERE component='LOCAL' AND origin_reference = invoiceId` is exactly `0`;
  `program.local_reserved_minor` is back to its pre-reservation value.
- Second scenario: release the whole `33333` in one instalment — same end state.
- Third: release `33334` → 409 `RELEASE_EXCEEDS_RESERVED`, nothing written (assert the ledger row
  count is unchanged).

### Task 6: The release endpoint (T053)

`POST /v1/programs/:programId/reservations/:invoiceId/releases` on the existing `CapacityController`.
**The route parameter must be named exactly `programId`** — `ProgramScopeGuard` resolves ownership
only from that spelling and returns `true` for any other, silently disabling the check.
`x-required-scope: capacity:write`, the write throttler only (phase 3's throttle scoping),
`Idempotency-Key` header required.

Verification: a caller without `capacity:write` gets 403; a foreign program id gets 404.

### Task 7: `test/contract/releases.contract.spec.ts` (T049)

Assert the wire contract: **201** on a fresh release carrying `reservation` + `availability`, and
**200** on an idempotent replay with an identical body (`contracts/http-api.yaml`); 409
`CURRENCY_MISMATCH`; 409 `RELEASE_EXCEEDS_RESERVED`; 409 `RESERVATION_TERMINAL`; 404
`RESERVATION_NOT_FOUND`; 400 on a malformed amount; `details` never contains a `stack`, `sql` or
`query` key. Confirm `contracts/errors.md` and `contracts/http-api.yaml` both still state 409 for
`CURRENCY_MISMATCH` — they do today, so **expect no document edit**; if one has drifted, 409 wins.

## Final Verification

```bash
docker compose down -v && docker compose up -d
npm run migration:run && npm run seed
npm run lint && npm run typecheck && npm test && npm run test:cov && npm run build
```

Expected: no `boundaries/dependencies` violation; all contract and integration specs pass; coverage
holds the 80% global threshold — **never lower `coverageThreshold` to make this pass**.

Manual check (token printed by the seed):

```bash
curl -i -X POST "$BASE/v1/programs/b1b2c3d4-0001-4000-8000-000000000011/reservations/INV-0001/releases" \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: rel-0001" \
  -H "Content-Type: application/json" \
  -d '{"amount":{"amountMinor":"33333","currency":"EUR"}}'
```

Expected `201`; repeating the identical command returns `200` with the identical body; changing only
the amount under the same key returns `409 IDEMPOTENCY_CONFLICT`.

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
assumption is invalid, and the minimum planning decision required to continue. Do not propose or
implement an alternative unless explicitly asked to re-plan.
