# Canonical Error Codes

Every failure carries a stable `code`, a human-readable `message` that leaks no internal state, and
the request's `correlationId`. Codes are part of the contract — clients branch on them, so they
are additive-only.

## HTTP — refusals that changed nothing

| Code | HTTP | Meaning |
|---|---|---|
| `INSUFFICIENT_CAPACITY` | 409 | The amount exceeds available capacity. Distinct from over-limit. |
| `PROGRAM_OVER_LIMIT` | 409 | The program's total position exceeds its limit following treasury state. All new reservations are refused until it clears. |
| `RELEASE_EXCEEDS_RESERVED` | 409 | The converted release exceeds what remains reserved. Never clamped to the remainder. |
| `RESERVATION_TERMINAL` | 409 | The reservation is already fully released, cancelled, or written off. |
| `DUPLICATE_INVOICE` | 409 | A reservation already exists for this invoice on this program. |
| `IDEMPOTENCY_CONFLICT` | 409 | The `Idempotency-Key` was used before with different content. Nothing applied. Never a silent replay. |
| `IDEMPOTENCY_EXPIRED` | 409 | The `Idempotency-Key` is known but its stored outcome has aged past the retention window, so it cannot be replayed. Nothing applied. |
| `REQUEST_IN_FLIGHT` | 409 | An identical request under this key is still being applied. Retry; nothing was applied twice. |
| `FX_RATE_UNAVAILABLE` | 409 | No rate for the invoice→program currency pair. The reservation is refused rather than guessed. |
| `CURRENCY_MISMATCH` | 409 | A release was denominated in something other than the invoice's own currency. No implicit third-currency conversion. |
| `AMOUNT_ROUNDS_TO_ZERO` | 409 | The converted amount rounds to zero units of the program's currency. Refused as a typed outcome, never surfaced as a constraint violation. |
| `VALIDATION_FAILED` | 400 | Schema validation failed. `details` names the offending fields. |
| `UNAUTHENTICATED` | 401 | Missing, expired, or invalid token. |
| `INSUFFICIENT_SCOPE` | 403 | Authenticated and the program **is** the caller's, but the token lacks the scope the operation requires. Ownership is always resolved first, so this never reveals a program belonging to another organisation. |
| `RATE_LIMITED` | 429 | The calling organisation exceeded its request budget. `Retry-After` gives the wait in seconds. |
| `NOT_FOUND` | 404 | The program or reservation does not exist **or** is outside the caller's organisation. Deliberately indistinguishable. |
| `POSITION_UNVERIFIED` | 503 | The ledger was restored but this program's treasury stream position is unknown or behind. Writes are refused rather than serving a position the service cannot vouch for. Detected via `program.position_verified = FALSE`; the hold is per-program. Ownership resolution still runs first, so an out-of-scope program answers 404, not 503. |

## Kafka — quarantine reasons

Attached as a header on the message republished to `treasury.capacity.dlq`, alongside the original
topic, partition, offset, and correlation id.

| Reason | Meaning |
|---|---|
| `SCHEMA_INVALID` | Unparseable, or fails the JSON Schema contract. |
| `UNKNOWN_PROGRAM` | References a program this service does not hold. Quarantined, never silently discarded. |
| `CURRENCY_MISMATCH` | Asserts a currency other than the program's own. Never converted; the program currency is immutable. |
| `MISSING_ACK_MARKER` | A snapshot with no acknowledgement marker. The additive rule cannot be applied safely without one. |
| `VERSION_CONFLICT` | Version equals the applied state but content differs. Applies to **both** snapshots and incremental events. Quarantined rather than arbitrated. |
| `IMPLAUSIBLE_DELTA` | A snapshot implies a treasury correction above half the program's credit limit. Held for operator review rather than auto-applied. |
| `LIMIT_BELOW_LOCAL` | *(informational, not a quarantine)* A limit reduction leaves the limit under this service's own reservations. The message **is** applied and the program is marked over-limit; the reason is recorded for operator visibility. |
| `HANDLER_FAILURE` | Applying the message failed **permanently**. The transaction rolled back; nothing was applied. Transient failures (connection loss, pool exhaustion, lock timeout, serialization failure) are retried in place with backoff and never reach this topic. |

## Response body discipline

`details` carries only field-level validation information: the offending field paths and a reason
per field. It never carries stack traces, SQL fragments, driver messages, or identifiers belonging
to another organisation. The contract test asserts this — a `details` object containing a `stack`,
`sql`, or `query` key fails the build.

## What is deliberately absent

There is no code for a clamped or partially applied operation, because no operation clamps. Every
refusal above leaves the position exactly as it was.
