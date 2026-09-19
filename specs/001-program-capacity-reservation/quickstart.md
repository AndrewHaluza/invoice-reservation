# Quickstart & Validation Guide

**Date**: 2026-09-19 | **Plan**: [plan.md](./plan.md) | **Contracts**: [contracts/](./contracts/)

Proves the feature end to end from a clean clone in under 10 minutes (SC-008). This is a run and
validation guide — implementation lives in `tasks.md` and the source tree.

---

## Prerequisites

- Docker and Docker Compose
- Node.js 22 LTS (only needed to run the suite outside containers)
- No external network access required. FX rates and tokens are seeded locally.

---

## Start

```bash
cp .env.example .env
docker compose up -d          # Postgres 16, Redis, Redpanda
npm run migration:run
npm run seed                  # 2 organisations, 3 programs, FX rates, 2 tokens
npm run start:dev             # the service, on PORT (3000 by default)
```

Every host port the stack publishes is parameterised, and defaults to the canonical one:
`PG_PORT` (5432), `REDIS_PORT` (6379), `KAFKA_PORT` (9092), `KAFKA_SASL_PORT` (9093),
`REDPANDA_ADMIN_PORT` (9644). Container-internal ports never move — only the published port does.
Redpanda advertises the published port on its host-facing listeners, and bootstraps its SASL user
and topics over a separate in-container listener (`INTERNAL://localhost:19092`), so a host client
that follows the advertised address reconnects correctly whatever port the stack was given.

### One stack per worktree

`scripts/dev-stack.sh` runs all of the above as one command, and is what Karst starts for a ticket
(`repositories.service.service.start` in `.karst/karst.yml`). It makes concurrent tickets safe:

- the compose project name is derived from the worktree path, so containers, the network and the
  `pgdata` volume are namespaced per worktree;
- the published ports come from Karst's per-ticket port allocation (six slots: `http`, `pg`,
  `redis`, `kafka`, `kafkaSasl`, `redpandaAdmin`, from the `portRange`);
- `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `REDIS_URL` and `KAFKA_BROKERS` are derived from those
  ports unconditionally, so an inherited `.env` cannot silently repoint a ticket at another stack.

```bash
scripts/dev-stack.sh          # stack + npm ci if needed + migrations + seed + API
scripts/dev-stack.sh up       # the stack only
scripts/dev-stack.sh down     # tear THIS worktree's stack down, volumes included
scripts/dev-stack.sh reap     # remove stacks whose worktree no longer exists
scripts/dev-stack.sh env      # print the env this worktree resolves to
```

N worktrees therefore run N complete, independent stacks at once. The script tears its own stack
down when the API exits (`KARST_KEEP_STACK=1` opts out), but Karst stops a service with an
untrappable `SIGKILL`, so a stack can outlive its ticket; `reap` — which also runs automatically at
the start of every `up` — removes any stack whose worktree directory is gone.

The seed prints two bearer tokens: `ACME_TOKEN` (owns programs A and B) and `OTHER_TOKEN` (owns
program C). Keep both — the cross-tenant check needs them.

Confirm readiness:

```bash
curl -s localhost:3000/health/ready | jq
```

---

## Scenario 1 — Reserve, read, release (US1, US2, US4)

```bash
export T=$ACME_TOKEN
export P=<program A id from the seed output>

# Availability starts at the full $10,000,000 limit
curl -s -H "Authorization: Bearer $T" localhost:3000/v1/programs/$P/availability | jq

# Reserve $2,000,000
curl -s -X POST -H "Authorization: Bearer $T" -H "Idempotency-Key: demo-res-1" \
  -H 'Content-Type: application/json' \
  -d '{"invoiceId":"INV-1","amount":{"amountMinor":"200000000","currency":"USD"}}' \
  localhost:3000/v1/programs/$P/reservations | jq
```

**Expected**: `201`. `availability.available.amountMinor` is `"800000000"`. The response carries
the resulting position, so no second call is needed.

```bash
# Release it in full
curl -s -X POST -H "Authorization: Bearer $T" -H "Idempotency-Key: demo-rel-1" \
  -H 'Content-Type: application/json' \
  -d '{"amount":{"amountMinor":"200000000","currency":"USD"}}' \
  localhost:3000/v1/programs/$P/reservations/INV-1/releases | jq
```

**Expected**: available back to `"1000000000"`, reservation status `FULLY_RELEASED`.

---

## Scenario 2 — Over-reservation is refused (US1, SC-001)

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $T" \
  -H "Idempotency-Key: demo-res-too-big" -H 'Content-Type: application/json' \
  -d '{"invoiceId":"INV-BIG","amount":{"amountMinor":"1100000000","currency":"USD"}}' \
  localhost:3000/v1/programs/$P/reservations
```

**Expected**: `409` with code `INSUFFICIENT_CAPACITY`. Availability unchanged.

---

## Scenario 3 — Idempotency, including the conflict case (FR-006a)

```bash
# Exact retry: replayed, not re-applied
curl -s -X POST -H "Authorization: Bearer $T" -H "Idempotency-Key: demo-res-2" \
  -H 'Content-Type: application/json' \
  -d '{"invoiceId":"INV-2","amount":{"amountMinor":"100000000","currency":"USD"}}' \
  localhost:3000/v1/programs/$P/reservations | jq -r '.availability.available.amountMinor'

curl -s -X POST -H "Authorization: Bearer $T" -H "Idempotency-Key: demo-res-2" \
  -H 'Content-Type: application/json' \
  -d '{"invoiceId":"INV-2","amount":{"amountMinor":"100000000","currency":"USD"}}' \
  localhost:3000/v1/programs/$P/reservations | jq -r '.availability.available.amountMinor'
```

**Expected**: identical figures, `200` on the second call, capacity reduced once.

```bash
# Same key, different amount: refused, never silently replayed
curl -s -X POST -H "Authorization: Bearer $T" -H "Idempotency-Key: demo-res-2" \
  -H 'Content-Type: application/json' \
  -d '{"invoiceId":"INV-2","amount":{"amountMinor":"500000000","currency":"USD"}}' \
  localhost:3000/v1/programs/$P/reservations | jq -r '.code'
```

**Expected**: `IDEMPOTENCY_CONFLICT`, nothing applied.

---

## Scenario 4 — Cross-currency reserve and repay nets to zero (US1, SC-004a)

The seed fixes **EUR→USD at 1.0850000000**, effective at epoch, source `seed`. The scenario's
arithmetic is only checkable because that value is pinned: 33333 EUR minor units convert to
`round_half_up(33333 × 1.085) = 36166` USD minor units.

```bash
# EUR invoice against the USD program, repaid in two instalments
curl -s -X POST -H "Authorization: Bearer $T" -H "Idempotency-Key: fx-res-1" \
  -H 'Content-Type: application/json' \
  -d '{"invoiceId":"INV-EUR","amount":{"amountMinor":"33333","currency":"EUR"}}' \
  localhost:3000/v1/programs/$P/reservations | jq '.reservation.fx, .reservation.reserved'

curl -s -X POST -H "Authorization: Bearer $T" -H "Idempotency-Key: fx-rel-1" \
  -H 'Content-Type: application/json' -d '{"amount":{"amountMinor":"11111","currency":"EUR"}}' \
  localhost:3000/v1/programs/$P/reservations/INV-EUR/releases > /dev/null

curl -s -X POST -H "Authorization: Bearer $T" -H "Idempotency-Key: fx-rel-2" \
  -H 'Content-Type: application/json' -d '{"amount":{"amountMinor":"22222","currency":"EUR"}}' \
  localhost:3000/v1/programs/$P/reservations/INV-EUR/releases \
  | jq '.reservation.status, .reservation.outstanding.reserved.amountMinor'
```

**Expected**: reserved `"36166"` USD; after the first instalment (11111 EUR → 12055 USD)
outstanding is `"24111"`; the final instalment settles the invoice's full remainder, so it snaps
to exactly the reserved remainder and the status becomes `FULLY_RELEASED` with outstanding `"0"`.
Summing the three ledger entries for this reservation gives exactly zero — the rounding residual
strands no minor units.

---

## Scenario 5 — Cancellation is distinguishable from repayment (US3, FR-026)

```bash
curl -s -X POST -H "Authorization: Bearer $T" -H "Idempotency-Key: cancel-1" \
  -H 'Content-Type: application/json' -d '{"reason":"WRITTEN_OFF","note":"buyer insolvent"}' \
  localhost:3000/v1/programs/$P/reservations/INV-2/cancellation | jq -r '.reservation.status'

curl -s -H "Authorization: Bearer $T" "localhost:3000/v1/programs/$P/ledger?cause=WRITE_OFF" | jq '.items'
```

**Expected**: status `WRITTEN_OFF`; a ledger entry with cause `WRITE_OFF`, not `RELEASE`.

---

## Scenario 6 — Treasury event and snapshot (US5, US6)

```bash
# Raise the limit to $12,000,000
docker compose exec redpanda rpk topic produce treasury.capacity.events -k "$P" <<< "$(cat <<JSON
{"messageId":"evt-1","programId":"$P","version":1,"effectiveAt":"2026-09-19T10:00:00Z",
 "type":"LIMIT_CHANGED","payload":{"amountMinor":"1200000000","currency":"USD"}}
JSON
)"

sleep 2 && curl -s -H "Authorization: Bearer $T" localhost:3000/v1/programs/$P/availability \
  | jq '.creditLimit.amountMinor, .treasury.appliedVersion, .treasury.lagSeconds'
```

**Expected**: limit `"1200000000"`, `appliedVersion` `1`, a small `lagSeconds`.

```bash
# Replay the identical message byte-for-byte — must have no second effect
docker compose exec redpanda rpk topic produce treasury.capacity.events -k "$P" <<< "$(cat <<'JSON'
{"messageId":"evt-1","programId":"PROGRAM_ID","version":1,"effectiveAt":"2026-09-19T10:00:00Z",
 "type":"LIMIT_CHANGED","payload":{"amountMinor":"1200000000","currency":"USD"}}
JSON
)"

# A snapshot OLDER than the applied state — must be ignored
docker compose exec redpanda rpk topic produce treasury.capacity.snapshots -k "$P" <<< "$(cat <<'JSON'
{"messageId":"snap-old","programId":"PROGRAM_ID","version":0,"effectiveAt":"2026-09-19T09:00:00Z",
 "currency":"USD","creditLimitMinor":"1000000000","reservedMinor":"0",
 "acknowledgement":{"kind":"WATERMARK","ingestedThrough":"2026-09-19T09:00:00Z"}}
JSON
)"

# A late INCREMENTAL event below the applied version — must still apply (FR-012a)
docker compose exec redpanda rpk topic produce treasury.capacity.events -k "$P" <<< "$(cat <<'JSON'
{"messageId":"evt-late","programId":"PROGRAM_ID","version":0,"effectiveAt":"2026-09-19T09:30:00Z",
 "type":"RESERVATION_BOOKED","payload":{"amountMinor":"200000","currency":"USD",
 "reservationReference":"treasury-own-1"}}
JSON
)"
```

**Expected**: the replayed event and the old snapshot both leave the figures unchanged. The late
*incremental* event **does** apply, raising treasury reserved by 200000 — a delta asserts a change,
not a state, and discarding it would lose that capacity permanently and silently.

```bash
# A snapshot with no acknowledgement marker is quarantined, not applied
docker compose exec redpanda rpk topic consume treasury.capacity.dlq --num 1 | jq
```

**Expected**: the message appears on the DLQ with reason `MISSING_ACK_MARKER`, and the program is
unchanged.

---

## Scenario 7 — Snapshot is additive over unacknowledged local reservations (US6, FR-011a)

```bash
# Reserve 500,000 locally
curl -s -X POST -H "Authorization: Bearer $T" -H "Idempotency-Key: snap-res-1" \
  -H 'Content-Type: application/json' \
  -d '{"invoiceId":"INV-SNAP","amount":{"amountMinor":"500000","currency":"USD"}}' \
  localhost:3000/v1/programs/$P/reservations > /dev/null

# Snapshot asserting 3,500,000 reserved, watermarked BEFORE that reservation was confirmed
docker compose exec redpanda rpk topic produce treasury.capacity.snapshots -k "$P" <<< "$(cat <<'JSON'
{"messageId":"snap-1","programId":"PROGRAM_ID","version":10,"effectiveAt":"2026-09-19T11:00:00Z",
 "currency":"USD","creditLimitMinor":"1200000000","reservedMinor":"3500000",
 "acknowledgement":{"kind":"WATERMARK","ingestedThrough":"2026-09-19T10:00:00Z"}}
JSON
)"

sleep 2
curl -s -H "Authorization: Bearer $T" localhost:3000/v1/programs/$P/availability \
  | jq '.reserved.total.amountMinor, .reserved.local.amountMinor, .reserved.treasury.amountMinor'

curl -s -H "Authorization: Bearer $AUDIT_T" \
  "localhost:3000/v1/programs/$P/ledger?cause=RECONCILIATION_ADJUSTMENT" | jq '.items'
```

**Expected**: total `"4000000"`, not `"3500000"` — the local 500,000 is added on top because the
watermark predates its confirmation, so the snapshot could not have accounted for it. Local stays
`"500000"` and treasury becomes `"3500000"`. The adjustment appears in the ledger against the
`TREASURY` component only; the `LOCAL` component is untouched, because nothing about our own books
was wrong. Summing the ledger per component reproduces all three reported figures.

---

## Scenario 9 — Limit cut below local reservations is recorded, not rejected (FR-011c)

```bash
# With 8,000,000 reserved locally, treasury cuts the facility to 5,000,000
docker compose exec redpanda rpk topic produce treasury.capacity.events -k "$P" <<< "$(cat <<'JSON'
{"messageId":"evt-cut","programId":"PROGRAM_ID","version":20,"effectiveAt":"2026-09-19T12:00:00Z",
 "type":"LIMIT_CHANGED","payload":{"amountMinor":"500000000","currency":"USD"}}
JSON
)"

sleep 2
curl -s -H "Authorization: Bearer $T" localhost:3000/v1/programs/$P/availability \
  | jq '.creditLimit.amountMinor, .available.amountMinor, .overLimit'
```

**Expected**: the limit **is** lowered, `available` is reported as a negative number, and
`overLimit` is true. New reservations are refused with `PROGRAM_OVER_LIMIT` until the position
returns within the limit, at which point the mark clears on the next position change without
operator action. The cut is never rejected — treasury is the system of record for the limit, and
refusing it would leave the service lending against a facility that no longer exists.

---

## Scenario 10 — Rate limiting (FR-033)

```bash
for i in $(seq 1 200); do
  curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $T" \
    localhost:3000/v1/programs/$P/availability
done | sort | uniq -c
```

**Expected**: a mix of `200` and `429`. The `429` responses carry `Retry-After`. Repeating the
loop with `$OTHER_TOKEN` concurrently still returns `200` — the budget is per organisation, so one
tenant cannot exhaust another's.

---

## Scenario 8 — Authentication and tenancy (SC-007, SC-007a)

```bash
# No token
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/v1/programs/$P/availability   # 401

# Wrong organisation's token against program A
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $OTHER_TOKEN" \
  localhost:3000/v1/programs/$P/availability                                          # 404, not 403
```

**Expected**: `401` then `404`. The 404 is deliberate — a 403 would confirm the program exists.

---

## Test suite

```bash
npm test                  # unit + integration, Testcontainers spins up Postgres and Redpanda
npm run test:cov          # must report >= 80% (Constitution VI)
```

### The four mandatory tests

Constitution VI names these explicitly; they are the first tasks implemented, and none of them can
pass against mocks:

| Test | Proves |
|---|---|
| `test/integration/concurrency.spec.ts` | 1,000 concurrent reservations on one program never over-reserve, across 20 consecutive runs (SC-001) |
| `test/integration/idempotency.spec.ts` | Duplicate requests and duplicate Kafka messages change the position zero times; key reuse with different content is refused (SC-005) |
| `test/integration/stale-reconciliation.spec.ts` | An older snapshot is ignored; a newer one applies as a compensating entry and replay reproduces the position (SC-006) |
| `test/integration/currency-mismatch.spec.ts` | A reservation with no available rate is refused; a treasury message in the wrong currency is quarantined, never converted |

### Additional gates worth running before calling it done

```bash
npm run test:contract     # OpenAPI conformance + enumerates every route to prove auth AND scope (SC-007/007a)
npm run audit:ledger      # scripts/audit-ledger.ts — asserts position == Σ ledger per component (SC-004)
npm run test:recovery     # test/integration/ledger-recovery.spec.ts — restore, resume, assert no loss (SC-010)
npm run test:migration    # up then down then up; the Constitution merge gate
npm run test:perf         # SC-002, SC-002a, SC-003, SC-003a — release gate, not per-commit
```

---

## Shutdown

```bash
docker compose down -v        # or, from a worktree: scripts/dev-stack.sh down
```

`-v` removes the `pgdata` volume of **this** compose project only, so tearing one worktree's stack
down never touches another's database.
