# Phase 1 Data Model: End-to-End API Tests

**Feature**: 004-e2e-api-tests | **Date**: 2026-09-21

This feature introduces no schema. What follows is the state each scenario must establish
and the invariants it asserts — the model the tests reason about, not a new one.

---

## Program

The unit capacity is measured against. Rows inserted directly by the suite's owner
connection during setup, exactly as the existing HTTP-level specs do.

| Field | Type | Role in this feature |
|---|---|---|
| `id` | uuid | Path parameter. **Must be named `programId` in the route** — `ProgramScopeGuard` resolves ownership only from that name and returns `true` for any other spelling. |
| `organisation_id` | uuid | Ownership. Decides `404` versus success for a given token. |
| `currency` | char(3) | ISO-4217. Must match the request amount's currency or an FX rate must exist. |
| `credit_limit_minor` | bigint | The limit. |
| `local_reserved_minor` | bigint | What this service has reserved. **Database-constrained to stay at or below the limit** (Principle III), so it alone can never produce the over-limit condition. |
| `treasury_reserved_minor` | bigint | Externally asserted. The only field that can push the total above the limit. |
| `next_sequence` | bigint | Ledger sequence. |
| `over_limit_since` | timestamptz null | The recorded mark. **Not read by the refusal decision** — `isOverLimit` recomputes from the position, so writing this column alone changes nothing. |
| `position_verified` | boolean | When false, every write refuses with `POSITION_UNVERIFIED` *before* the over-limit check. Must be true for User Story 1's over-limit scenario to reach its refusal. |

### Derived quantities

```text
totalReserved = local_reserved_minor + treasury_reserved_minor
available     = credit_limit_minor - totalReserved
isOverLimit   = totalReserved > credit_limit_minor
```

All three in `bigint`. The suite computes them the same way and never in floating point.

### Ordering of refusal checks

The order matters, because a scenario that sets up two conditions at once observes only the
first. From `decideReservation`:

1. `positionVerified === false` → `POSITION_UNVERIFIED`
2. `isOverLimit` → `PROGRAM_OVER_LIMIT`
3. FX unavailable → `FX_RATE_UNAVAILABLE`
4. conversion rounds to zero → `AMOUNT_ROUNDS_TO_ZERO`
5. `reservedMinor > availableMinor` → `INSUFFICIENT_CAPACITY`

**Consequence for User Story 2**: a program used for the boundary scenarios must be
verified, within its limit, and in the request's own currency, or the boundary comparison
is never reached and the test passes for the wrong reason.

---

## Reservation

| Field | Role |
|---|---|
| `invoice_id` | Unique per program. A second reservation of the same identifier raises `DUPLICATE_INVOICE` — User Story 1, scenario 3. |
| `amount_minor` / currency | The claim. Crosses the wire as a decimal string, never a JSON number. |
| `status` | `ACTIVE`, `FULLY_RELEASED`, `CANCELLED`, `WRITTEN_OFF`. The last three are terminal. |

---

## Idempotency record (`request_record`)

Primary key: organisation plus request identifier. Carries a state and a content
fingerprint.

| State observed | Refusal | Covered over HTTP today? |
|---|---|---|
| Complete, fingerprint matches | none — replay the original outcome, `200` | yes |
| Complete, fingerprint differs | `IDEMPOTENCY_CONFLICT` | yes |
| **Pending** | **`REQUEST_IN_FLIGHT`** | **no — User Story 1, scenario 4** |
| **Aged past retention** | **`IDEMPOTENCY_EXPIRED`** | **no — User Story 1, scenario 5** |

These four are mutually exclusive and the distinction is the point: Principle IV forbids
replaying an outcome for a request whose content differs, and equally forbids treating an
in-flight request as complete. A scenario must therefore assert the *specific* code, not
merely that the request was refused.

---

## Caller credential

A signed token carrying an organisation identifier, a scope and an expiry. Minted in the
test with the same secret the application is configured with.

| Scope | Grants |
|---|---|
| `capacity:write` | reserve, release, cancel |
| read scope | availability, reservations, ledger |

Ownership is resolved from the organisation the token names against the program's current
owner — never from anything embedded in the token. A token for the wrong organisation
yields `404`, never `403`, so a refusal cannot reveal whether a program exists.

---

## Recorded position

The authority every writing scenario checks against, per FR-005. A correct response over a
wrong ledger is a defect, so each scenario that writes reads back:

- the program row's `local_reserved_minor`, and
- for contention, the sum of the accepted writes.

Principle II requires the reported position to equal the sum of the ledger entries at all
times. The suite asserts the program row because that is what a subsequent request reads;
the ledger's own arithmetic is already proven by `test/integration/ledger-audit.spec.ts`
and re-asserting it would breach FR-012.

---

## State transitions exercised

```text
within limit ──(treasury snapshot raises total)──▶ over limit
     ▲                                                 │
     └──────(release brings total back within)─────────┘

available = N  ──(reserve N)──▶  available = 0  ──(release M)──▶  available = M
```

The first transition is User Story 1, scenarios 1 and 2. The second is User Story 2,
scenarios 1 and 3. Both are round trips on purpose: a refusal that never clears is
indistinguishable from a sticky flag, and capacity that never returns is indistinguishable
from a leak.
