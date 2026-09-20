# Execution Plan: Close every finding from the nine-phase audit of `develop`

## Goal

Every finding raised by the nine-phase audit of `develop` is closed: the one silent data-loss
defect (a keyset cursor that skips rows) is fixed, the two contract violations are resolved, the
release-policy guard test guards the branch it is named for again, the four deliberate deviations
that live only in source comments are recorded in `docs/ASSUMPTIONS.md`, `tasks.md` reflects what
is actually merged, and the release gates that exist but are invoked by nothing are wired to
automation.

## Current State

All nine phases are merged into `develop` (`265c8fd`). No phase is stubbed: there are zero
`it.todo`/`.skip` tests and zero `TODO`/`FIXME`/`HACK` comments in `src/`, `test/` or `scripts/`.
The coverage gate is intact at 80/80/80/80 (`jest.config.ts:22-24`) and CI runs `lint`,
`typecheck`, `test`, `test:cov`, `build` (`.github/workflows/ci.yml:24-39`).

The audit found the following, all confirmed by reading the code:

1. **`listReservations` skips rows.** `invoice_reservation.created_at` is `TIMESTAMPTZ`
   (microsecond precision, `src/migrations/1758240000000-InitialSchema.ts:81`). The cursor is built
   from `last.created_at.toISOString()` (`src/capacity/application/audit-read.service.ts:194`),
   and `node-postgres` parses `timestamptz` into a JS `Date`, which holds only milliseconds. The
   next page's predicate is
   `(created_at, id) < ($n::timestamptz, $n::uuid)` (`:171-173`). If the last row of a page is at
   `…:00.500123`, the cursor says `…:00.500000`, so every not-yet-returned row in
   `[.500000, .500123)` is excluded from that page and from every later page. Those rows are never
   returned. This defeats FR-031 (complete audit history).
2. **The missing-`Idempotency-Key` 400 body violates the `Error` schema.**
   `contracts/http-api.yaml:529-530` constrains `details` with
   `propertyNames: { pattern: '^[A-Za-z0-9_.\[\]]+$' }` — no hyphen. The controller emits
   `details: { 'Idempotency-Key': 'required, 8 to 128 characters' }` at
   `src/capacity/api/capacity.controller.ts:72`, `:110` and `:148`. Latent: no contract test feeds
   that body to the Ajv validator.
3. **The phase-4 Key Decision 2 guard test no longer guards it.** The release policy was
   re-derived during execution: instead of computing `Δ = round_half_up(R × rate)` and refusing
   when `Δ > outstanding_reserved_minor`, it bounds the release in invoice currency
   (`src/capacity/domain/policies/release.policy.ts:70-72`) and derives `Δ` as the difference of
   converted outstandings (`:91-103`), refusing only when that difference is negative (`:107-109`).
   The shipped behaviour is sound and arguably stronger — it preserves
   `outstanding_reserved_minor === round_half_up(outstanding_invoice_minor × rate)` at every step.
   But `test/unit/release-policy.spec.ts:74-89`, written to prove the over-release refusal, now
   reaches the `deltaMinor < 0n` branch instead. The invariant the redesign is justified by is not
   asserted anywhere.
4. **Ledger paging limits contradict the contract.** `src/capacity/api/dto/list-ledger.query.ts:46`
   and `audit-read.service.ts:47` allow `limit` up to 1000 with a default of 100. `GET /ledger`
   references the shared `Limit` parameter, `maximum: 200, default: 50`
   (`contracts/http-api.yaml:334-337`, referenced at `:252`).
5. **The error filter synthesises non-canonical codes.** `src/capacity/api/error.filter.ts:63-76`
   maps code-less framework `HttpException`s to `UNAUTHORIZED`, `FORBIDDEN`, `CONFLICT`,
   `SERVICE_UNAVAILABLE`, `METHOD_NOT_ALLOWED`, `NOT_ACCEPTABLE`, `PAYLOAD_TOO_LARGE`,
   `UNSUPPORTED_MEDIA_TYPE`, `UNPROCESSABLE_ENTITY`. None appear in `contracts/errors.md`, which
   states codes are contract surface. Reachable via 405/413/415.
6. **`tasks.md` does not reflect the tree.** `grep -c "T10[123]"` returns 0 and
   `grep -c -- "- \[x\]"` returns 0 against
   `specs/001-program-capacity-reservation/tasks.md` on `develop`. T101 (retention sweep), T102
   (extended verifier) and T103 (FX cache fix) are all implemented but have no task-list entry, and
   no checkbox has ever been ticked for any of the 102 tasks.
7. **The release gates run nowhere.** `test:perf`, `test:recovery`, `reconcile`, `audit:ledger` and
   `scripts/verify-uat.sh` are real gates (jest `expect`s and `exit 1`s) but `.github/workflows/ci.yml`
   invokes only `npm run test:cov`.
8. **Four deliberate deviations are recorded only in source comments**, not in
   `docs/ASSUMPTIONS.md`: the phase-8 trigger relaxation
   (`src/migrations/1758260000000-SnapshotLocalCorrectionTrigger.ts`), the phase-7 decision to
   write no `processed_message` row on quarantine (`src/treasury/consumer/treasury.consumer.ts:354-357`),
   the phase-2 Redis failure policy (`src/auth/redis.provider.ts:11-13`, which logs and continues
   where the plan said to fail loudly), and the phase-4 policy redesign above.
9. **Minor:** `reconciliationPending` takes `MAX(version)` across all acknowledgement kinds
   (`src/capacity/application/availability.service.ts:38-57`), so a newer `WATERMARK` masks an
   older still-pending `EXPLICIT` acknowledgement; `src/capacity/application/apply-snapshot.service.ts:384`
   computes its guard threshold through a float
   (`BigInt(Math.floor(ratio * Number(creditLimitMinor)))`); `scripts/verify-uat.sh:236-251` guards
   every phase-9 artifact except T101; and `src/treasury/jobs/request-retention.job.ts` leaves an
   over-age `PENDING` row silently.

## Target State

- `listReservations` pages with microsecond fidelity; a row can never be skipped by paging.
- Every error body the service can emit validates against `#/components/schemas/Error`, proven by a
  contract test.
- The release policy's justifying invariant is asserted by a test, and the over-release refusal is
  reached by a test that exercises the branch that actually implements it.
- `contracts/http-api.yaml` describes the ledger limits the service enforces.
- `contracts/errors.md` enumerates the framework-originated codes.
- `docs/ASSUMPTIONS.md` records all four deviations with what-breaks and how-detected.
- `tasks.md` contains T101–T103 and every merged task is ticked.
- A scheduled and manually dispatchable workflow runs the release gates.
- `reconciliationPending` is not masked by a later `WATERMARK`; the snapshot guard threshold is
  exact bigint arithmetic; `verify-uat.sh` guards T101; an over-age `PENDING` row is logged.

## Scope

### In Scope

- `src/capacity/application/audit-read.service.ts` — cursor precision.
- `src/capacity/api/capacity.controller.ts` — the `details` key on the three 400 bodies.
- `src/capacity/api/dto/list-ledger.query.ts` — unchanged; the contract moves to match it.
- `specs/001-program-capacity-reservation/contracts/http-api.yaml` — a dedicated ledger limit parameter.
- `specs/001-program-capacity-reservation/contracts/errors.md` — framework-originated codes.
- `specs/001-program-capacity-reservation/tasks.md` — T101–T103 and checkboxes.
- `docs/ASSUMPTIONS.md` — four deviation records.
- `src/capacity/application/availability.service.ts` — `EXPLICIT`-scoped `MAX(version)`.
- `src/capacity/application/apply-snapshot.service.ts` — exact threshold arithmetic.
- `src/treasury/jobs/request-retention.job.ts` — aged-`PENDING` warning.
- `scripts/verify-uat.sh` — T101 guard.
- `.github/workflows/release-gates.yml` — new.
- Tests accompanying each of the above.

### Out of Scope

- Changing the release policy's algorithm. It ships as written; only the tests and the record change.
- Computing a real `lagSeconds`. It remains `null`, which is contract-legal and recorded.
- Enabling TLS on the local Kafka listener. Recorded in `docs/kafka-acls.md`; not reopened here.
- Making the retention sweep cadence configurable. It stays a hardcoded 1 h constant.
- Adding a `processed_message` row on quarantine. The current behaviour is correct under FR-036;
  only the record changes.
- Any refactor not named by a task in this plan.

## Key Decisions

1. **Cursor precision is fixed by selecting an explicit microsecond text rendering, not by
   truncating the column.** Truncating with `date_trunc('milliseconds', created_at)` in both
   `ORDER BY` and the predicate would also work but changes the sort key of a paged audit endpoint
   and makes the index at `InitialSchema.ts` unusable for the ordering. Instead the query selects
   an extra computed column rendering `created_at` to microseconds as text, and the cursor carries
   that string. The predicate already casts the cursor value with `::timestamptz`, which parses a
   microsecond ISO-8601 string exactly. `ORDER BY created_at DESC, id DESC` is unchanged.
2. **The `Idempotency-Key` 400 body changes; the ratified contract does not.** `details` is
   specified as *field-level validation information*, and its `propertyNames` pattern deliberately
   excludes hyphens. A header is not a field. The key becomes `idempotencyKey`, which matches the
   pattern and the camelCase convention of every DTO property. The human-readable message continues
   to name the header, so nothing is lost to the caller. Widening the pattern to admit hyphens was
   rejected: it would relax a ratified non-disclosure surface to accommodate one call site.
3. **The ledger limit contract moves to match the code, not the reverse.** The phase-5 plan
   mandated 100/1000 deliberately (audit pages are bulk reads). Lowering the service to 200/50 would
   be a functional regression against a ratified plan. A dedicated `LedgerLimit` parameter is added
   and `GET /ledger` references it; the shared `Limit` parameter is untouched so the reservations
   route keeps 200/50.
4. **Framework-originated error codes are documented, not removed.** Mapping 405/413/415 to a
   generic `INTERNAL` would discard information a client can act on. They are recorded in
   `errors.md` in a separate table marked as framework-originated, preserving the additive-only
   rule.
5. **`reconciliationPending` scopes its `MAX(version)` to `kind = 'EXPLICIT'`.** The flag exists to
   surface a pending explicit acknowledgement; a `WATERMARK` at a higher version is not evidence
   that the explicit one was handled.
6. **The snapshot guard threshold uses integer arithmetic scaled by 10000.** The ratio is a float
   from config in `(0, 1]`. `Math.round(ratio * 10000)` converts it once to an integer basis point
   count; the comparison becomes `magnitude * 10000n > BigInt(basisPoints) * creditLimitMinor`,
   which is exact for every int64 limit.
7. **Release gates run on a schedule and on demand, not on every pull request.** They need
   testcontainers and take minutes. A nightly cron plus `workflow_dispatch` gives the signal without
   slowing the PR loop. The existing `ci.yml` is not modified.
8. **Every checkbox in `tasks.md` is ticked.** All nine phases are merged; the audit confirmed every
   task implemented in substance. Leaving some unticked would require a per-task judgement the
   audit already made.

## Execution Order

### Task 1: Make the reservations cursor microsecond-exact

#### Objective

`listReservations` must never skip a row because the cursor lost sub-millisecond precision.

#### Files

- `src/capacity/application/audit-read.service.ts` — the paged query, the row interface and the
  cursor construction.
- `test/integration/reservations-paging.spec.ts` — created; proves the defect is gone.

#### Implementation

Current behaviour: the query selects `*` from `invoice_reservation`; the driver returns
`created_at` as a JS `Date` (millisecond precision); `encodeCursor({ createdAt: last.created_at.toISOString(), id: last.id })`
at line 194 therefore emits a millisecond-truncated timestamp; the next page's predicate
`(created_at, id) < ($a::timestamptz, $b::uuid)` excludes rows between the truncated value and the
true value of the last returned row.

Required behaviour: the cursor carries the microsecond-exact value of the last returned row.

1. In the `InvoiceReservationRow` interface (the one declared around line 40-64, containing
   `created_at: Date`), add a field:

   ```ts
   created_at_cursor: string;
   ```

2. In `listReservations`, change the query's select list from `SELECT *` to:

   ```sql
   SELECT *,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
   ```

   Leave `FROM`, `WHERE ${conditions.join(' AND ')}`, `ORDER BY created_at DESC, id DESC` and
   `LIMIT $${parameters.length}` exactly as they are.

3. Change the cursor construction (currently
   `createdAt: last.created_at.toISOString()`) to:

   ```ts
   createdAt: last.created_at_cursor,
   ```

4. Leave `decodeCursor`, the `ReservationCursor` interface, and the predicate
   `(created_at, id) < ($${parameters.length - 1}::timestamptz, $${parameters.length}::uuid)`
   unchanged. A microsecond ISO-8601 string with a `Z` suffix casts to `timestamptz` exactly.

5. `toReservationBody(toInvoiceReservationEntity(row))` continues to receive the row; the extra
   column is ignored by the mapper. Do not add `created_at_cursor` to the entity or the response
   body.

Create `test/integration/reservations-paging.spec.ts` following the structure of the existing
`test/integration/ledger-audit.spec.ts` (same testcontainers harness, same `AppModule`-free direct
service construction if that spec does so; otherwise mirror whichever bootstrap `ledger-audit.spec.ts`
uses). It must contain two cases:

- **"returns every reservation across pages when timestamps collide at millisecond precision"**:
  insert 6 `invoice_reservation` rows for one program whose `created_at` values share the same
  millisecond but differ in microseconds — e.g. write them with explicit
  `created_at = '2026-01-01T00:00:00.500001Z'` … `'2026-01-01T00:00:00.500006Z'`. Page with
  `limit: 2` until `nextCursor` is null, collecting every returned `invoiceId`. Assert the collected
  set has exactly 6 members and equals the set inserted. Before this task's change this assertion
  fails, returning 2.
- **"pages deterministically when created_at is exactly equal"**: insert 4 rows all at
  `'2026-01-01T00:00:01.000000Z'` with distinct ids, page with `limit: 2`, assert all 4 are returned
  exactly once (this proves the id tiebreak still works alongside the new cursor value).

#### Constraints

- Do not change `ORDER BY created_at DESC, id DESC`.
- Do not change the ledger paging path — its cursor keys on `sequence`, which is gapless and
  unique, and is already correct.
- Do not change the shape of `ReservationCursor` (`{ createdAt: string; id: string }`), so cursors
  issued before this change still decode.
- Do not expose `created_at_cursor` in any API response.

#### Edge Cases

- A cursor issued before this change carries a millisecond value; it still decodes and still casts
  to `timestamptz`. It may skip rows one final time on the page it was issued for; that is
  acceptable and requires no migration.
- A row whose `created_at` has zero microseconds renders as `…:00.000000Z` and compares identically.
- An empty result set produces `nextCursor: null` and never dereferences `last`; the existing
  `hasMore && last !== undefined` guard covers this and must be preserved.

#### Verification

```bash
npm run typecheck
npx jest test/integration/reservations-paging.spec.ts
```

Expected:
- Typecheck passes.
- Both cases pass. Reverting only the `created_at_cursor` change makes the first case fail.

#### Completion Criteria

- [ ] `InvoiceReservationRow` declares `created_at_cursor: string`.
- [ ] The reservations query selects the `to_char(...) AS created_at_cursor` column.
- [ ] The cursor is built from `last.created_at_cursor`.
- [ ] `test/integration/reservations-paging.spec.ts` exists with both named cases and passes.
- [ ] No change to the ledger paging path.

### Task 2: Emit a schema-valid `details` key on the missing-`Idempotency-Key` 400

#### Objective

Every error body the service emits validates against `#/components/schemas/Error`.

#### Files

- `src/capacity/api/capacity.controller.ts` — three 400 bodies.
- `test/contract/reservations.contract.spec.ts` — add a validating case.

#### Implementation

Current behaviour: three call sites emit
`details: { 'Idempotency-Key': 'required, 8 to 128 characters' }` — at lines 72, 110 and 148
(the reserve, release and cancellation handlers). `contracts/http-api.yaml:529-530` constrains
`details` with `propertyNames: { pattern: '^[A-Za-z0-9_.\[\]]+$' }`, which excludes the hyphen, so
these bodies are invalid.

Required behaviour: the property name is `idempotencyKey`; the message still names the header.

1. At each of the three sites, replace the `details` object with:

   ```ts
   details: { idempotencyKey: 'required, 8 to 128 characters' },
   ```

2. Leave the surrounding `code` and `message` fields exactly as they are. Do not change the HTTP
   status, which is 400.

3. Do not edit `contracts/http-api.yaml`.

In `test/contract/reservations.contract.spec.ts`, add a case
**"the missing Idempotency-Key 400 validates against the Error schema"**: `POST` the reserve route
with a valid body and no `Idempotency-Key` header, assert status 400, assert
`body.details` has the single key `idempotencyKey`, and validate the whole body with the existing
`openapiValidator` against `#/components/schemas/Error` exactly as the neighbouring cases in that
file do (follow the existing call convention in the file rather than inventing one).

#### Constraints

- Do not widen the `propertyNames` pattern in the contract.
- Do not change the `VALIDATION_FAILED` code or the 400 status.
- Do not touch `toValidationDetails` in `src/capacity/api/error.filter.ts`; it derives keys from
  class-validator messages and already produces pattern-valid names.

#### Edge Cases

- A present-but-too-short `Idempotency-Key` takes the same branch and therefore the same body; the
  new key applies to it identically.
- The release and cancellation routes emit the same literal; all three must change, or the contract
  test on one route would pass while another route stays invalid.

#### Verification

```bash
npm run typecheck
npx jest test/contract/reservations.contract.spec.ts
grep -rn "'Idempotency-Key':" src/
```

Expected:
- Typecheck passes; the contract spec passes including the new case.
- The `grep` returns no matches in `src/` (the header name may still appear inside message strings
  and in `@ApiHeader`-style metadata; the grep above targets the object-key form specifically).

#### Completion Criteria

- [ ] All three sites emit `details: { idempotencyKey: … }`.
- [ ] The new contract case exists and passes.
- [ ] `contracts/http-api.yaml` is unmodified.

### Task 3: Restore the release-policy guard test and assert the invariant the redesign rests on

#### Objective

The over-release refusal is proven on the branch that implements it, and the invariant justifying
the phase-4 redesign is asserted.

#### Files

- `test/unit/release-policy.spec.ts` — fix one case, add two.

#### Implementation

Current behaviour: `src/capacity/domain/policies/release.policy.ts` refuses an over-release at line
70-72 — `if (releaseMinor > reservation.outstandingInvoiceMinor) return err('RELEASE_EXCEEDS_RESERVED')`
— i.e. in the *invoice* currency, before any conversion. A second, distinct refusal at `:107-109`
returns the same code when the derived `deltaMinor` is negative, which happens only for a
reservation row whose `outstanding_reserved_minor` is below the converted outstanding invoice
(an inconsistent row). The existing case at `test/unit/release-policy.spec.ts:74-89` is named for
the over-release refusal but constructs input that reaches the `deltaMinor < 0n` branch instead.

Required behaviour: both branches are covered by separately named cases, and the invariant
`outstandingReservedMinor === round_half_up(outstandingInvoiceMinor × rate)` is shown to hold after
a partial release.

1. Rename the existing case at `:74-89` to
   **"refuses an inconsistent reservation whose reserved is below its converted invoice"** and
   leave its input and its `RELEASE_EXCEEDS_RESERVED` expectation as they are. Add an inline comment
   stating that this exercises the `deltaMinor < 0n` branch at `release.policy.ts:107-109`.
2. Add a case **"refuses a release larger than the outstanding invoice"**: build a consistent
   reservation — `outstandingInvoiceMinor: 1000n`, `outstandingReservedMinor` equal to
   `round_half_up(1000 × rate)` for the chosen rate — and call `releasePolicy` with
   `releaseMinor: 1001n`. Assert the result is `err('RELEASE_EXCEEDS_RESERVED')`. Add an inline
   comment stating that this exercises the invoice-currency bound at `release.policy.ts:70-72`.
3. Add a case
   **"keeps outstandingReserved equal to the converted outstanding invoice after a partial release"**:
   using a sub-1 rate (for example `scaleRate('0.9216589862')`, the seed's USD→EUR rate) and
   `outstandingInvoiceMinor: 1000n` with `outstandingReservedMinor` set to
   `round_half_up(1000 × rate)`, release `400n`. Assert the decision's
   `outstandingInvoiceMinor === 600n` and that its `outstandingReservedMinor` equals
   `convert(money(600n, programCurrency), programCurrency, rate)`'s minor amount — computed in the
   test with the same `convert`/`scaleRate` helpers the policy uses, imported from
   `src/shared/money/convert`. This is the invariant the phase-4 redesign exists to preserve.

Use the existing helpers, fixtures and import style already present in
`test/unit/release-policy.spec.ts`; do not introduce a new test utility.

#### Constraints

- Do not modify `src/capacity/domain/policies/release.policy.ts`. The shipped algorithm is
  correct and is being kept deliberately; this task changes tests only.
- Do not delete the existing case; rename it.
- Do not change the `ReleaseRefusal` union.

#### Edge Cases

- The chosen rate must be such that `round_half_up(1000 × rate)` is non-zero, or the policy refuses
  with `AMOUNT_ROUNDS_TO_ZERO` before reaching the branch under test.
- In case 3 the remainder must be non-zero after conversion, or the policy snaps to
  `FULLY_RELEASED` and `outstandingReservedMinor` is `0n` by the FR-009b path rather than by the
  invariant.

#### Verification

```bash
npx jest test/unit/release-policy.spec.ts
```

Expected:
- All cases pass, including the three named above.

#### Completion Criteria

- [ ] The existing case is renamed and annotated with the branch it reaches.
- [ ] A case named for the invoice-currency over-release bound exists and passes.
- [ ] A case asserting the reserved/invoice conversion invariant exists and passes.
- [ ] `release.policy.ts` is unmodified.

### Task 4: Give `GET /ledger` its own limit parameter in the contract

#### Objective

The OpenAPI document describes the ledger paging limits the service actually enforces.

#### Files

- `specs/001-program-capacity-reservation/contracts/http-api.yaml` — add a parameter, change one
  reference.

#### Implementation

Current behaviour: `GET /ledger` references the shared `Limit` parameter
(`http-api.yaml:334-337`, referenced at `:252`), which declares `maximum: 200, default: 50`. The
service enforces `maximum: 1000, default: 100`
(`src/capacity/api/dto/list-ledger.query.ts:46`, `src/capacity/application/audit-read.service.ts:47`).

Required behaviour: a distinct `LedgerLimit` parameter declaring 1000/100, referenced only by the
ledger route.

1. In `components.parameters`, immediately after the existing `Limit` parameter definition, add:

   ```yaml
   LedgerLimit:
     name: limit
     in: query
     required: false
     description: >
       Maximum ledger entries per page. The ledger is a bulk audit read, so it admits a larger page
       than the reservation list: entries are small, immutable and sequence-ordered, and an auditor
       reconstructing a position reads the whole history.
     schema:
       type: integer
       minimum: 1
       maximum: 1000
       default: 100
   ```

   Match the surrounding indentation and the field ordering used by the existing `Limit` parameter.

2. At the `GET /ledger` operation, change the parameter reference from
   `#/components/parameters/Limit` to `#/components/parameters/LedgerLimit`. Leave the `Cursor`
   parameter reference and the `from`/`to`/`cause` filter parameters unchanged.

3. Do not change the `Limit` parameter itself — `GET /reservations` still references it and the
   service enforces 200/50 there (`src/capacity/api/dto/list-reservations.query.ts:26`).

#### Constraints

- Do not change any DTO or service constant. The code is correct; the contract is being corrected.
- Do not alter the `Page` or `LedgerEntry` schemas.

#### Edge Cases

- The document must remain parseable. Any YAML indentation error here breaks every contract test,
  which loads this file.

#### Verification

```bash
node -e "const y=require('yaml');const f=require('fs');const d=y.parse(f.readFileSync('specs/001-program-capacity-reservation/contracts/http-api.yaml','utf8'));const p=d.components.parameters.LedgerLimit;console.log(p.schema.maximum,p.schema.default);console.log(d.components.parameters.Limit.schema.maximum,d.components.parameters.Limit.schema.default);"
npx jest test/contract/availability.contract.spec.ts
```

Expected:
- The first command prints `1000 100` then `200 50`.
- The contract spec, which validates ledger pages against this document, passes.

#### Completion Criteria

- [ ] `LedgerLimit` exists with `maximum: 1000`, `default: 100`.
- [ ] `GET /ledger` references `LedgerLimit`.
- [ ] `Limit` is unchanged and still referenced by `GET /reservations`.
- [ ] The document parses and the contract spec passes.

### Task 5: Document the framework-originated error codes

#### Objective

`contracts/errors.md` enumerates every `code` the service can emit.

#### Files

- `specs/001-program-capacity-reservation/contracts/errors.md` — add one table.

#### Implementation

Current behaviour: `src/capacity/api/error.filter.ts:63-76` maps a code-less `HttpException` to a
code derived from its status: `UNAUTHORIZED` (401), `FORBIDDEN` (403), `CONFLICT` (409),
`SERVICE_UNAVAILABLE` (503), `METHOD_NOT_ALLOWED` (405), `NOT_ACCEPTABLE` (406),
`PAYLOAD_TOO_LARGE` (413), `UNSUPPORTED_MEDIA_TYPE` (415), `UNPROCESSABLE_ENTITY` (422). None are
listed in `errors.md`, which states that codes are contract surface.

Required behaviour: they are listed, and marked as framework-originated so no reader mistakes them
for domain refusals.

1. Read `src/capacity/api/error.filter.ts:63-76` and transcribe the mapping exactly — do not work
   from the list above if the file disagrees; the file is authoritative.

2. Immediately after the existing `## HTTP — refusals that changed nothing` table and before the
   `## Kafka — quarantine reasons` heading, insert:

   ```markdown
   ## HTTP — framework-originated

   These codes are not domain refusals. They are emitted when the HTTP layer itself rejects a
   request before any domain code runs — an unroutable method, an unreadable body, an oversized
   payload — and the raised `HttpException` therefore carries no domain `code`. The filter derives
   the code from the status so that every response still carries one. They are additive-only on the
   same terms as the table above.

   | Code | HTTP | Meaning |
   |---|---|---|
   ```

   followed by one row per mapping read in step 1, each with a one-line meaning written in the
   voice of the existing table (state what happened, not what the framework class is called).

3. Do not modify the existing tables or the `LIMIT_BELOW_LOCAL` note.

#### Constraints

- Do not change `error.filter.ts`. The behaviour is being documented, not altered.
- Do not remove or renumber any existing row.

#### Edge Cases

- If the filter maps a status this plan did not name, include it. If it omits one this plan named,
  omit it. The source file wins.

#### Verification

```bash
grep -n "framework-originated" specs/001-program-capacity-reservation/contracts/errors.md
grep -c "|" specs/001-program-capacity-reservation/contracts/errors.md
```

Then, for each code string in `error.filter.ts:63-76`:

```bash
grep -c "METHOD_NOT_ALLOWED" specs/001-program-capacity-reservation/contracts/errors.md
```

Expected:
- The new heading exists; every code emitted by the filter appears at least once in the document.

#### Completion Criteria

- [ ] A `## HTTP — framework-originated` section exists with one row per status mapping in
      `error.filter.ts`.
- [ ] Every code string in `error.filter.ts:63-76` appears in `errors.md`.
- [ ] No existing row was changed.

### Task 6: Scope `reconciliationPending` to explicit acknowledgements

#### Objective

A later `WATERMARK` acknowledgement can no longer mask an older, still-pending `EXPLICIT` one.

#### Files

- `src/capacity/application/availability.service.ts` — the derivation query.
- `test/integration/snapshot-decomposition.spec.ts` — add one case.

#### Implementation

Current behaviour: `availability.service.ts:38-57` derives `reconciliationPending` with an `EXISTS`
over `snapshot_acknowledgement sa` joined to `invoice_reservation r` on
`r.treasury_reference = ANY(sa.reservation_references)`, filtered by `sa.kind = 'EXPLICIT'` and
`r.status <> 'ACTIVE'`, where `sa.version = (SELECT MAX(version) FROM snapshot_acknowledgement WHERE program_id = …)`.
The inner `MAX(version)` is computed across all acknowledgement kinds, so if the newest row for the
program is a `WATERMARK`, the outer `sa.kind = 'EXPLICIT'` predicate can never be satisfied and the
flag reads false even while an explicit acknowledgement is outstanding.

Required behaviour: the inner `MAX(version)` considers only `EXPLICIT` rows.

1. Add `AND kind = 'EXPLICIT'` to the `WHERE` clause of the inner
   `SELECT MAX(version) FROM snapshot_acknowledgement …` subquery, so it reads
   `WHERE program_id = $1 AND kind = 'EXPLICIT'` (preserve the existing parameter placeholder
   number, whatever it is in the file).
2. Leave the outer `sa.kind = 'EXPLICIT'` predicate, the join condition, the `r.status <> 'ACTIVE'`
   predicate and the parameter list unchanged.
3. Add a comment above the subquery: `// Scoped to EXPLICIT: a later WATERMARK is not evidence that an explicit acknowledgement was corrected.`

Add a case to `test/integration/snapshot-decomposition.spec.ts` named
**"reports reconciliationPending when a WATERMARK acknowledgement is newer than a pending EXPLICIT one"**:
apply a snapshot producing an `EXPLICIT` acknowledgement at version N that references a reservation
subsequently moved out of `ACTIVE`, then insert or apply a `WATERMARK` acknowledgement at version
N+1 for the same program, then read availability and assert `reconciliationPending === true`. Before
this change it reads `false`. Follow the harness and fixture conventions already used in that spec.

#### Constraints

- Do not add a `reconciliation_pending` column. The flag is derived at read time by design and the
  audit confirmed zero occurrences of that column name anywhere.
- Do not change the response shape; `reconciliationPending` stays an optional boolean in the
  contract and is always emitted.

#### Edge Cases

- A program with no `EXPLICIT` acknowledgement at all: the inner subquery returns `NULL`,
  `sa.version = NULL` is never true, `EXISTS` is false, and the flag reads `false`. Correct.
- A program whose only acknowledgements are `WATERMARK`: same as above, `false`. Correct.

#### Verification

```bash
npm run typecheck
npx jest test/integration/snapshot-decomposition.spec.ts
```

Expected:
- Typecheck passes; the spec passes including the new case.

#### Completion Criteria

- [ ] The inner `MAX(version)` subquery filters `kind = 'EXPLICIT'`.
- [ ] The explanatory comment is present.
- [ ] The new integration case exists and passes.

### Task 7: Compute the snapshot magnitude guard with exact integer arithmetic

#### Objective

The `IMPLAUSIBLE_DELTA` threshold is exact for every int64 credit limit.

#### Files

- `src/capacity/application/apply-snapshot.service.ts` — the threshold helper.
- `test/unit/apply-snapshot-guard.spec.ts` — created, or the existing unit spec covering the guard
  if one already exists (check `test/unit/` for a spec referencing `IMPLAUSIBLE_DELTA` and extend
  it rather than creating a duplicate).

#### Implementation

Current behaviour: around line 377-387 the helper computes

```ts
const threshold = BigInt(Math.floor(ratio * Number(creditLimitMinor)));
```

and the caller compares `magnitude > threshold`. `Number(creditLimitMinor)` is lossy above 2^53
(≈ 9.007e15 minor units), so near the top of the int64 range the threshold can be wrong by up to
about 1024 minor units. The threshold never reaches a ledger entry or a persisted column — it only
decides `IMPLAUSIBLE_DELTA` quarantine — so this is a correctness tidy, not a money defect.

Required behaviour: no float touches a money bigint.

1. Replace the threshold computation and the comparison with an exact form. Convert the ratio once
   to integer basis points and compare by cross-multiplication:

   ```ts
   // `ratio` is a configured float in (0, 1]. Converting it once to an integer
   // basis-point count keeps the comparison exact for every int64 limit; going
   // through `Number(creditLimitMinor)` loses precision above 2^53.
   const basisPoints = BigInt(Math.round(ratio * 10_000));
   const exceedsGuard = magnitude * 10_000n > basisPoints * creditLimitMinor;
   ```

   Keep the helper's existing name, signature and return type. If it currently returns the
   threshold, change it to return the boolean and update its single call site (the
   `IMPLAUSIBLE_DELTA` branch around line 208-215) to use the boolean directly; if it already
   returns a boolean, keep that shape.

2. `magnitude` is the absolute treasury delta and is already a `bigint`; `creditLimitMinor` is
   already a `bigint`. Do not introduce any `Number()` conversion in this path.

3. Leave the scope of the guard unchanged: it applies to `|delta_treasury|` only, per Key Decision
   9 of the phase-8 plan.

Add unit cases proving:
- **"quarantines a treasury delta above the guard ratio"** — ratio `0.5`, limit `1000n`, magnitude
  `501n` → exceeds.
- **"admits a treasury delta exactly at the guard ratio"** — ratio `0.5`, limit `1000n`, magnitude
  `500n` → does not exceed (the comparison is strictly greater-than; preserve that).
- **"is exact for a credit limit above 2^53"** — ratio `0.5`, limit `9_007_199_254_740_993n`,
  magnitude `4_503_599_627_370_497n` (one more than half) → exceeds. Under the old float form this
  case is misclassified.

#### Constraints

- Do not change `SNAPSHOT_DELTA_GUARD_RATIO`, its Joi schema (`greater(0).max(1).default(0.5)`), or
  its `.env.example` entry.
- Do not widen the guard to other components.
- Preserve the strict `>` comparison; a delta exactly at the threshold is admitted today.

#### Edge Cases

- `ratio = 1` → `basisPoints = 10000n`; the comparison becomes `magnitude > creditLimitMinor`.
- `creditLimitMinor = 0n` → any positive magnitude exceeds, which is the existing behaviour and
  must be preserved.
- A ratio such as `0.33333` rounds to `3333` basis points, a deliberate quantisation to four
  decimal places of an operator-chosen heuristic. State this in the comment.

#### Verification

```bash
npm run typecheck
npx jest test/unit/apply-snapshot-guard.spec.ts
grep -n "Number(" src/capacity/application/apply-snapshot.service.ts
```

Expected:
- Typecheck passes; all three cases pass.
- The `grep` shows no `Number(` applied to a money bigint in the guard path.

#### Completion Criteria

- [ ] The threshold comparison uses only bigint arithmetic.
- [ ] Three unit cases exist and pass, including the above-2^53 case.
- [ ] The guard's scope, ratio config and strict `>` semantics are unchanged.

### Task 8: Surface an over-age PENDING request record

#### Objective

A `request_record` row stuck in `PENDING` past the retention window is visible in the logs instead
of being silently skipped.

#### Files

- `src/treasury/jobs/request-retention.job.ts` — add a count-and-warn step.
- `test/integration/idempotency-retention.spec.ts` — add one case.

#### Implementation

Current behaviour: the sweep runs
`UPDATE request_record SET state='EXPIRED', outcome=NULL WHERE state='COMPLETE' AND recorded_at < cutoff`
(around lines 28-34). The `state='COMPLETE'` predicate means an over-age `PENDING` row — a request
that began and never finished — is left untouched and unreported.

Required behaviour: the sweep counts over-age `PENDING` rows and logs a warning naming the count
when it is non-zero. It must not modify them.

1. After the existing `UPDATE`, add a second query in the same method:

   ```sql
   SELECT count(*)::int AS stuck FROM request_record
    WHERE state = 'PENDING' AND recorded_at < $1
   ```

   using the same `cutoff` parameter the `UPDATE` already computes.

2. If the count is greater than zero, emit
   `this.logger.warn(\`\${stuck} request_record row(s) have been PENDING since before the retention cutoff; a writer crashed mid-request and the key cannot be replayed or reused\`)`
   using the existing logger instance on the class. If the count is zero, log nothing.

3. Do not change the `UPDATE`, the cutoff computation, the `REQUEST_RETENTION_DAYS` config key, or
   the hardcoded 1 h sweep interval constant.

Add a case to `test/integration/idempotency-retention.spec.ts` named
**"leaves an over-age PENDING row untouched and warns"**: insert a `PENDING` row with
`recorded_at` before the cutoff, run the sweep, assert the row is still `PENDING` with its
`outcome` unchanged, and assert the logger warning was emitted — spy on the job's logger using
whatever spying convention the surrounding specs already use; if none exists in that file, assert
only the row-level invariants and the returned count if the method returns one.

#### Constraints

- Do not delete or modify `PENDING` rows. A `PENDING` row is the only record that a key is in
  flight; removing it would let a retry be mistaken for a new request.
- Do not make the sweep cadence configurable.
- Do not change the `EXPIRED`/`outcome = NULL` semantics for `COMPLETE` rows.

#### Edge Cases

- Zero stuck rows: no log line at all, not a "0 rows" line.
- A `PENDING` row newer than the cutoff: not counted.

#### Verification

```bash
npm run typecheck
npx jest test/integration/idempotency-retention.spec.ts
```

Expected:
- Typecheck passes; the spec passes including the new case and the pre-existing cases
  (`EXPIRED` state, null outcome, fingerprint retained, row count unchanged).

#### Completion Criteria

- [ ] The sweep counts over-age `PENDING` rows and warns when non-zero.
- [ ] No `PENDING` row is modified or deleted.
- [ ] The new integration case exists and passes.

### Task 9: Record the four deliberate deviations in `docs/ASSUMPTIONS.md`

#### Objective

Every decision that departs from a ratified plan is recorded where the project records such things,
not only in a source comment.

#### Files

- `docs/ASSUMPTIONS.md` — append four entries.

#### Implementation

Read `docs/ASSUMPTIONS.md` first and match the existing entry format exactly — the existing entries
carry a statement, what breaks if it is wrong, and how it would be detected. Reproduce that
structure; do not invent a new one.

Append four entries, in this order. Before writing each, open the cited file and confirm the
behaviour is still as described; if a file disagrees, write what the file does.

1. **The reservation-path trigger stands down for reconciliation writes.**
   `src/migrations/1758260000000-SnapshotLocalCorrectionTrigger.ts` redefines
   `assert_local_within_limit()` to return early when the session setting
   `capacity.reconciliation_in_progress` is `'on'`, which
   `src/capacity/application/apply-snapshot.service.ts` sets for the duration of its transaction.
   The phase-2 trigger fires `WHEN (NEW.local_reserved_minor > OLD.local_reserved_minor)`, which a
   legitimate reconciliation correction does trip, so FR-011c/FR-011g could not be honoured without
   an escape. The phase-8 plan had said to report a blocking constraint rather than relax it; the
   trigger was relaxed instead. What breaks if this is wrong: a bug in the snapshot path could raise
   `local_reserved_minor` above the limit without the backstop firing. How it is detected: the
   reservation path never sets the GUC, so its backstop is unchanged, and
   `npm run audit:ledger` recomputes every component from the ledger.

2. **A quarantined message gets no `processed_message` row.**
   `src/treasury/consumer/treasury.consumer.ts` publishes to the DLQ and commits the offset without
   recording a dedupe row, departing from the phase-7 plan's task 9 wording. FR-036 requires a
   replayed DLQ message to re-enter the ordinary validation and deduplication path, which a dedupe
   row would turn into a privileged no-op. What breaks if this is wrong: a crash between the DLQ
   publish and the offset commit republishes the same message, producing duplicate quarantine
   entries. No capacity is lost, because nothing was applied. How it is detected: duplicate
   `messageId`s in the DLQ topic.

3. **Redis unavailability degrades rate limiting instead of failing startup.**
   `src/auth/redis.provider.ts` installs an `error` listener that logs and continues, where the
   phase-2 plan required the error to propagate and fail startup loudly. What breaks if this is
   wrong: a Redis outage silently removes per-organisation rate limiting while the API keeps
   serving. How it is detected: the error is logged on every failed connection attempt, and
   `maxRetriesPerRequest: 3` bounds the retry.

4. **The release policy derives its delta by differencing converted outstandings.**
   `src/capacity/domain/policies/release.policy.ts` bounds the release in invoice currency and
   derives the capacity delta as the difference between the converted outstanding invoice before
   and after, rather than converting the release amount on its own as the phase-4 plan specified.
   This preserves
   `outstanding_reserved_minor === round_half_up(outstanding_invoice_minor × rate)` at every step,
   so a sub-1 rate cannot drain the reserved remainder ahead of the invoice and strand the
   reservation short of `FULLY_RELEASED`. What breaks if this is wrong: a reservation could be left
   with unreleasable capacity. How it is detected: the invariant is asserted by
   `test/unit/release-policy.spec.ts`, and `test/integration/release-nets-to-zero.spec.ts` proves
   the `LOCAL` component sums to zero across a full repayment.

#### Constraints

- Do not edit any source file in this task. It records what exists.
- Do not remove or reword existing entries.

#### Edge Cases

- If an entry for any of these four already exists, extend it rather than adding a duplicate.

#### Verification

```bash
grep -c "reconciliation_in_progress" docs/ASSUMPTIONS.md
grep -c "processed_message" docs/ASSUMPTIONS.md
grep -c "redis" docs/ASSUMPTIONS.md
grep -c "release policy" docs/ASSUMPTIONS.md
```

Expected:
- Each returns at least 1 (the `redis` grep is case-insensitive in effect only if the entry uses
  that spelling; use `grep -ci` if the first attempt returns 0).

#### Completion Criteria

- [ ] Four entries appended, each with statement, what-breaks and how-detected.
- [ ] The existing entries are unchanged.
- [ ] No source file changed.

### Task 10: Bring `tasks.md` into line with the merged tree

#### Objective

`tasks.md` lists T101–T103 and marks every merged task complete.

#### Files

- `specs/001-program-capacity-reservation/tasks.md` — add three tasks, tick all checkboxes.

#### Implementation

Current state on `develop`: `grep -c "T10[123]"` returns 0 and `grep -c -- "- \[x\]"` returns 0.
All nine phases are merged and the audit confirmed every task implemented in substance.

1. Add **T101** to the Polish & Cross-Cutting phase, in the strict checklist format the file uses
   (`- [ ] T101 Description with file path`, no story label for polish-phase tasks):
   the FR-006b retention sweep over `request_record`, implemented in
   `src/treasury/jobs/request-retention.job.ts`, which sets `state='EXPIRED'` and `outcome=NULL`
   for `COMPLETE` rows older than `REQUEST_RETENTION_DAYS` while keeping the row so a reused
   identifier stays distinguishable from a new one.
2. Add **T102** to the same phase: extend `scripts/verify-uat.sh` to the phase 3–8 acceptance
   criteria.
3. Add **T103** to the User Story 2 phase, positioned before T047, with the `[US2]` story label:
   correct the `CachedRateProvider` cache key in `src/fx/cached-rate.provider.ts` so a cached rate
   is served only when `asOf >= entry.effectiveAt`.
4. Change every `- [ ]` in the file to `- [x]`. Do this for all tasks including the three added
   above, since all nine phases are merged.
5. If the file carries a dependency note for the Polish phase that enumerates task ids, update it to
   include T101 and T102.

#### Constraints

- Preserve the strict checklist format: checkbox, task id, optional `[P]`, story label for user-story
  phases only, description with file path.
- Do not renumber or reword existing tasks.
- Do not change the phase headings or the implementation-strategy section.

#### Edge Cases

- A line that looks like a checkbox inside a fenced code block, if any exists, must not be
  rewritten. Inspect the file before a blanket substitution.

#### Verification

```bash
grep -c -- "- \[ \]" specs/001-program-capacity-reservation/tasks.md
grep -c -- "- \[x\]" specs/001-program-capacity-reservation/tasks.md
grep -n "T101\|T102\|T103" specs/001-program-capacity-reservation/tasks.md
```

Expected:
- The first command prints `0`.
- The second prints at least `105`.
- The third shows T101, T102 and T103 each on one line, T103 before T047's line number.

#### Completion Criteria

- [ ] T101, T102 and T103 exist in the correct phases with the correct labels.
- [ ] Zero unticked checkboxes remain.
- [ ] No existing task was renumbered or reworded.

### Task 11: Guard T101 in `verify-uat.sh` and wire the release gates to CI

#### Objective

The release gates that exist run on a schedule and on demand, and the verifier covers the retention
sweep.

#### Files

- `scripts/verify-uat.sh` — add one check to the phase-9 section.
- `.github/workflows/release-gates.yml` — created.

#### Implementation

Current behaviour: `scripts/verify-uat.sh` (266 lines) encodes checks for phases 1–9, but its
phase-9 section (around lines 235-251) checks the reconciliation interval, the recovery spec, the
performance specs, the jobs, the ACL doc and the assumptions record — and never
`request-retention.job.ts` or `REQUEST_RETENTION_DAYS`. Separately, `.github/workflows/ci.yml` runs
only `npm ci`, `lint`, `typecheck`, `test`, `test:cov`, `build`; `test:perf`, `test:recovery`,
`reconcile`, `audit:ledger` and `verify-uat.sh` are invoked by nothing.

1. In the phase-9 section of `scripts/verify-uat.sh`, add a check in the same style as the
   surrounding ones asserting that `src/treasury/jobs/request-retention.job.ts` exists, that it
   contains the string `EXPIRED`, and that `REQUEST_RETENTION_DAYS` appears in both
   `src/config/env.schema.ts` and `.env.example`. Follow the file's existing helper functions and
   failure-reporting convention exactly; do not introduce a new reporting mechanism.

2. Create `.github/workflows/release-gates.yml`:

   ```yaml
   name: release-gates

   on:
     workflow_dispatch:
     schedule:
       - cron: '0 3 * * *'

   jobs:
     gates:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v7
         - uses: actions/setup-node@v7
           with:
             node-version: 22
             cache: npm
         - run: npm ci
         - name: Static acceptance verifier
           run: bash scripts/verify-uat.sh
         - name: Ledger recovery
           run: npm run test:recovery
         - name: Performance gates
           run: npm run test:perf
   ```

   Match the action versions and the Node version already used by `.github/workflows/ci.yml` — read
   that file and copy them rather than trusting the snippet above if it differs.

3. Do not modify `.github/workflows/ci.yml`. The pull-request loop stays as it is; these gates are
   slower and need testcontainers.

4. Do not add `reconcile` or `audit:ledger` to the workflow: both require a seeded live database
   rather than testcontainers, and running them against an empty schema would report a false pass.
   State this in a comment at the bottom of the workflow file.

#### Constraints

- Do not weaken, skip or add `continue-on-error` to any gate. A failing gate must fail the workflow.
- Do not change any jest config, threshold or script in `package.json`.

#### Edge Cases

- Testcontainers requires a Docker daemon; `ubuntu-latest` provides one. Do not add a `services:`
  block — the specs start their own containers.
- A scheduled workflow on a fork does not run; that is acceptable and needs no handling.

#### Verification

```bash
bash -n scripts/verify-uat.sh
bash scripts/verify-uat.sh
node -e "const y=require('yaml');const f=require('fs');const w=y.parse(f.readFileSync('.github/workflows/release-gates.yml','utf8'));console.log(Object.keys(w.on));console.log(w.jobs.gates.steps.map(s=>s.run||s.uses));"
```

Expected:
- `bash -n` reports no syntax error.
- `verify-uat.sh` exits 0, including the new T101 check.
- The node command prints the two triggers and the step list including `bash scripts/verify-uat.sh`,
  `npm run test:recovery` and `npm run test:perf`.

#### Completion Criteria

- [ ] `verify-uat.sh` checks the retention job and `REQUEST_RETENTION_DAYS` in both files, and
      exits 0.
- [ ] `.github/workflows/release-gates.yml` exists with `workflow_dispatch` and a schedule.
- [ ] It runs the verifier, the recovery spec and the performance specs, none of them
      `continue-on-error`.
- [ ] `ci.yml` is unmodified.

## Final Verification

1. Run the full default suite and the gates the way CI and the new workflow will.
2. Confirm the two defects that motivated tasks 1 and 2 are closed by their own specs.
3. Confirm no contract document regressed.

Commands:

```bash
npm run lint
npm run typecheck
npm test
npm run test:cov
npm run build
bash scripts/verify-uat.sh
npm run test:recovery
npm run test:perf
```

Expected:
- `lint`, `typecheck` and `build` succeed.
- `npm test` passes with zero skipped or todo tests.
- `test:cov` passes the 80/80/80/80 threshold, which must not have been lowered.
- `verify-uat.sh` exits 0.
- `test:recovery` and `test:perf` pass within their asserted budgets.

Then confirm the paper trail:

```bash
grep -c -- "- \[ \]" specs/001-program-capacity-reservation/tasks.md
grep -rn "'Idempotency-Key':" src/
```

Expected:
- The first prints `0`.
- The second returns no object-key matches.

## Executor Rules

1. Execute each task in a **separate sub-agent** with a fresh context; do not run multiple tasks
   inside one long-lived session.
2. Execute tasks strictly in numerical order.
3. Complete the current task and its verification before starting the next task.
4. Implement the solution described in the plan exactly.
5. Do not redesign architecture or substitute a different approach.
6. Do not add features, cleanup, abstractions, or refactors not explicitly required by the plan.
7. Do not omit planned behavior because another implementation appears simpler.
8. Do not reinterpret product requirements.
9. Do not make optional improvements.
10. Follow existing project conventions where the plan explicitly relies on them.
11. Run the verification specified for every task.
12. Mark a task complete only when its completion criteria are satisfied.
13. If implementation reveals information that does not affect the prescribed solution, continue
    execution.
14. Stop rather than improvise when the plan cannot be executed as written.

The executor may stop only for a concrete blocker such as:

- a referenced file, API, dependency, or subsystem does not exist;
- repository state materially contradicts facts the plan depends on;
- a required credential or external resource is unavailable;
- the prescribed implementation is technically impossible;
- executing the plan would require making an architectural or product decision not covered by the
  plan;
- two instructions in the plan directly contradict each other;
- verification proves that an assumption fundamental to the planned implementation is false.

When stopping, the executor must report:

- the task number;
- the exact blocker;
- the evidence establishing the blocker;
- which plan assumption is invalid;
- the minimum planning decision required to continue.

The executor must **not** propose or implement an alternative unless explicitly asked to re-plan.
