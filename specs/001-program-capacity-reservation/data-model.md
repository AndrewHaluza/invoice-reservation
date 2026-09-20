# Phase 1 Data Model: Program Capacity & Invoice Reservation

**Date**: 2026-09-19 | **Plan**: [plan.md](./plan.md) | **Research**: [research.md](./research.md)

All monetary columns are `BIGINT` holding **minor units** (cents) and are always accompanied by an
ISO-4217 `CHAR(3)` currency. No `NUMERIC`, no floats, no exceptions — Constitution I.

---

## Entities

### `organisation`

The party a program belongs to. A credential identifies exactly one.

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` PK | |
| `name` | `TEXT NOT NULL` | |
| `created_at` | `TIMESTAMPTZ NOT NULL` | |

Spec: Key Entity "Owning Organisation", FR-017.

---

### `program`

A committed credit facility, plus the derived position cache (research R3).

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` PK | |
| `organisation_id` | `UUID NOT NULL` FK → `organisation` | Resolved per request by `ProgramScopeGuard` |
| `currency` | `CHAR(3) NOT NULL` | Immutable for the life of the program (FR-013d) |
| `credit_limit_minor` | `BIGINT NOT NULL DEFAULT 0` | **Derived cache of the `LIMIT` ledger component** |
| `local_reserved_minor` | `BIGINT NOT NULL DEFAULT 0` | Derived cache of the `LOCAL` component |
| `treasury_reserved_minor` | `BIGINT NOT NULL DEFAULT 0` | Derived cache of the `TREASURY` component |
| `next_sequence` | `BIGINT NOT NULL DEFAULT 1` | Ledger sequence generator, advanced under the row lock |
| `over_limit_since` | `TIMESTAMPTZ NULL` | Non-null ⇒ program is over-limit |
| `treasury_version` | `BIGINT NOT NULL DEFAULT 0` | Highest applied **snapshot** version (FR-012) |
| `treasury_effective_at` | `TIMESTAMPTZ NULL` | Effective time of that state |
| `treasury_applied_effective_at` | `TIMESTAMPTZ NULL` | Effective time of the newest treasury message applied to this program, from either topic; distinct from `treasury_effective_at`, which records the last applied snapshot only; null until a treasury message has been applied |
| `position_changed_at` | `TIMESTAMPTZ NOT NULL` | Local commit time (FR-007a) |
| `investigation_required` | `BOOLEAN NOT NULL DEFAULT FALSE` | Set by the FR-019b invariant check |
| `position_verified` | `BOOLEAN NOT NULL DEFAULT TRUE` | `FALSE` ⇒ writes refused, `POSITION_UNVERIFIED` (FR-019e) |

**Constraints**

```sql
CHECK (local_reserved_minor >= 0)
CHECK (treasury_reserved_minor >= 0)
CHECK (credit_limit_minor >= 0)
CHECK (currency ~ '^[A-Z]{3}$')
```

**Constitution III is enforced by a trigger, not a table `CHECK`.** A `CHECK (local_reserved_minor
<= credit_limit_minor)` binds *both* operands, so it would abort a treasury-asserted limit
reduction — rejecting an assertion from the system of record, which Constitution III's own
rationale forbids. The constraint is therefore scoped to the direction it is meant to govern:

```sql
CREATE FUNCTION assert_local_within_limit() RETURNS trigger AS $$
BEGIN
  IF NEW.local_reserved_minor > NEW.credit_limit_minor THEN
    RAISE EXCEPTION 'local reserved %:% exceeds credit limit %',
      NEW.id, NEW.local_reserved_minor, NEW.credit_limit_minor
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER program_local_within_limit
  BEFORE UPDATE ON program FOR EACH ROW
  WHEN (NEW.local_reserved_minor > OLD.local_reserved_minor)   -- only when WE consume capacity
  EXECUTE FUNCTION assert_local_within_limit();
```

It fires only when this service increases its own reservations. A limit cut that leaves
`local_reserved_minor > credit_limit_minor` is **recorded**, and the program is marked over-limit
(FR-023) — the same treatment the mirror case already receives.

The total position is `local_reserved_minor + treasury_reserved_minor` and **may exceed**
`credit_limit_minor`. That is the deliberate scoping from Constitution III v2.0.0.

**Derived, not stored**: `available_minor = credit_limit_minor − (local + treasury) reserved`.
Reported **signed** everywhere, never floored — flooring would conceal the over-limit magnitude
FR-023 exists to surface.

Spec: Key Entity "Financing Program", FR-001, FR-023, FR-024.

---

### `invoice_reservation`

A claim on a program's capacity for one invoice.

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` PK | |
| `program_id` | `UUID NOT NULL` FK → `program` ON DELETE RESTRICT | |
| `invoice_id` | `TEXT NOT NULL` | Unique per program |
| `invoice_amount_minor` | `BIGINT NOT NULL` | In the invoice's own currency |
| `invoice_currency` | `CHAR(3) NOT NULL` | |
| `program_currency` | `CHAR(3) NOT NULL` | Denormalised so the FX constraint is expressible |
| `reserved_minor` | `BIGINT NOT NULL` | Converted into program currency |
| `outstanding_invoice_minor` | `BIGINT NOT NULL` | Remaining, invoice currency |
| `outstanding_reserved_minor` | `BIGINT NOT NULL` | Remaining, program currency |
| `fx_rate` | `NUMERIC(20,10) NULL` | Rate, not money — `NUMERIC` is correct here |
| `fx_rate_effective_at` | `TIMESTAMPTZ NULL` | |
| `fx_rate_source` | `TEXT NULL` | |
| `status` | `reservation_status NOT NULL` | Enum below |
| `origin` | `reservation_origin NOT NULL` | `LOCAL` only; see note |
| `treasury_acknowledged` | `BOOLEAN NOT NULL DEFAULT FALSE` | Drives the additive snapshot rule |
| `acknowledged_by_version` | `BIGINT NULL` | Snapshot version that acknowledged it (FR-011a) |
| `treasury_reference` | `TEXT NULL` | Treasury's own id, matched by `EXPLICIT` ack markers |
| `confirmed_at` | `TIMESTAMPTZ NOT NULL` | Commit instant, compared against `WATERMARK` markers |
| `created_at`, `updated_at` | `TIMESTAMPTZ NOT NULL` | |

`origin` retains the `TREASURY` value in the enum for forward compatibility, but **no path creates
a treasury-origin reservation row** — treasury state is carried solely as the
`treasury_reserved_minor` aggregate. Every row written by this service is `LOCAL`.

**Constraints**

```sql
UNIQUE (program_id, invoice_id)
CHECK (invoice_amount_minor > 0 AND reserved_minor > 0)
CHECK (outstanding_invoice_minor BETWEEN 0 AND invoice_amount_minor)
CHECK (outstanding_reserved_minor BETWEEN 0 AND reserved_minor)
CHECK ((invoice_currency = program_currency) = (fx_rate IS NULL))
CHECK (fx_rate IS NULL OR fx_rate > 0)
CHECK (treasury_acknowledged = (acknowledged_by_version IS NOT NULL))
```

`reserved_minor > 0` is a backstop only. A cross-currency amount that rounds to zero program minor
units is refused earlier, in the reserve policy, as the typed `AMOUNT_ROUNDS_TO_ZERO` — never as a
`23514` surfacing to the caller as a 500.

**`reservation_status` transitions**

```text
ACTIVE ──partial release──> PARTIALLY_RELEASED ──final release──> FULLY_RELEASED  (terminal)
   │            │
   │            └──cancel remainder──> WRITTEN_OFF   (terminal)
   └──cancel──> CANCELLED                            (terminal)
```

Terminal states accept no further release or cancellation (FR-027). `WRITTEN_OFF` is distinct from
`CANCELLED` so an audit can tell a never-funded invoice from a partially-repaid one abandoned —
the distinction FR-026 requires.

Spec: Key Entity "Invoice Reservation", FR-005, FR-009a–c, FR-025–028.

---

### `capacity_ledger_entry`

The authority. Append-only: `UPDATE` and `DELETE` are revoked from the application role
(`REVOKE UPDATE, DELETE ON capacity_ledger_entry FROM app_role;` — issued in the migration, not
merely intended).

**The revoke only binds if the application is not the table's owner.** PostgreSQL grants an
object's owner every privilege on it implicitly, and `REVOKE` against the owner is a no-op — so an
application connecting as the role that ran the migration would retain `UPDATE` and `DELETE`
regardless, and the append-only guarantee would be decorative. The deployment therefore separates
the two identities: migrations run as the owning role, and the service connects as a member of
`app_role`, which owns nothing. Locally this is `capacity` (owner) and `capacity_app` (member),
created when the Postgres container initialises. The integration test asserts that an `UPDATE`
issued on the connection the service actually uses raises SQLSTATE `42501`; asserting it on the
owner's connection would pass while proving nothing.

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` PK | |
| `program_id` | `UUID NOT NULL` FK → `program` ON DELETE RESTRICT | |
| `sequence` | `BIGINT NOT NULL` | Per-program, gapless; from `program.next_sequence` under the row lock |
| `delta_minor` | `BIGINT NOT NULL` | Signed: positive consumes capacity, negative returns it |
| `component` | `position_component NOT NULL` | `LOCAL`, `TREASURY`, or `LIMIT` |
| `cause` | `ledger_cause NOT NULL` | See below |
| `origin_reference` | `TEXT NULL` | Reservation id, message id, or request id |
| `actor` | `TEXT NOT NULL` | Organisation id, or `treasury`, or `system` |
| `correlation_id` | `TEXT NOT NULL` | Propagated from HTTP or Kafka; untrusted string, never format-interpolated |
| `occurred_at` | `TIMESTAMPTZ NOT NULL` | `now()` inside the locked transaction — never client-supplied |

`ledger_cause` ∈ `RESERVATION`, `RELEASE`, `CANCELLATION`, `WRITE_OFF`, `TREASURY_EVENT`,
`LIMIT_CHANGE`, `RECONCILIATION_ADJUSTMENT`, `OVER_LIMIT_ONSET`, `OVER_LIMIT_CLEARED`.

**Constraints**

```sql
UNIQUE (program_id, sequence)
```

**Not partitioned.** Monthly range partitioning was removed: PostgreSQL requires the partition key
in every unique constraint, so `UNIQUE (program_id, sequence)` and `PARTITION BY RANGE
(occurred_at)` cannot coexist — and widening the key to include `occurred_at` would let the same
`(program_id, sequence)` recur in different months, destroying the gapless property SC-004's
replay check depends on. Dropping a partition would also break the sum invariant permanently,
since checkpoint rows were rejected at spec level. At the stated scale (hundreds of programs, low
millions of reservations) partitioning bought nothing. See research R8.

**The invariant that makes SC-004 true:**

```sql
program.local_reserved_minor    = Σ delta_minor WHERE component = 'LOCAL'
program.treasury_reserved_minor = Σ delta_minor WHERE component = 'TREASURY'
program.credit_limit_minor      = Σ delta_minor WHERE component = 'LIMIT'
```

All three hold at every commit, because each cache is only ever advanced in the same transaction
that appends its entry. **The credit limit is a ledger-derived position like any other** — it is
never set directly, which is what Constitution II requires and what makes `available`
reconstructible from the audit API alone (SC-004b). A `LIMIT_CHANGE` entry carries the signed
difference against the `LIMIT` component: raising a 10,000,000 facility to 12,000,000 appends
`+2,000,000`; cutting it to 5,000,000 appends `−5,000,000`.

`OVER_LIMIT_ONSET` and `OVER_LIMIT_CLEARED` carry `delta_minor = 0` and `component = 'LIMIT'` —
they are recorded for audit (FR-024) without moving any position.

Spec: Key Entity "Capacity Ledger Entry", FR-011, FR-015, FR-019–019b.

---

### `request_record`

Idempotency, including conflict detection on identifier reuse.

| Column | Type | Notes |
|---|---|---|
| `organisation_id` | `UUID NOT NULL` FK → `organisation` | **PK part** |
| `request_id` | `TEXT NOT NULL` | **PK part** — caller-supplied |
| `operation` | `TEXT NOT NULL` | `RESERVE`, `RELEASE`, `CANCEL` |
| `content_fingerprint` | `TEXT NOT NULL` | SHA-256 over program, invoice, amount, currency |
| `state` | `request_state NOT NULL` | `PENDING`, `COMPLETE`, or `EXPIRED` |
| `outcome` | `JSONB NULL` | The response replayed on an exact retry; null while `PENDING` |
| `recorded_at` | `TIMESTAMPTZ NOT NULL` | |

```sql
PRIMARY KEY (organisation_id, request_id)
CHECK ((state = 'COMPLETE') = (outcome IS NOT NULL))
```

The key is **composite**. A single-column `request_id` PK would let one organisation's key collide
with another's — at best a spurious conflict, at worst replaying org A's stored outcome to org B.
Every lookup filters on both columns.

**The `PENDING` row is inserted first, in the same transaction as the work.** Two concurrent
retries of the same request both find no record; the second's insert violates the PK and is
refused as a typed retry-later rather than applying twice.

Matching identifier **and** fingerprint ⇒ replay the outcome. Matching identifier, differing
fingerprint ⇒ `IDEMPOTENCY_CONFLICT`, nothing applied (FR-006a).

**Retention**: records are retained indefinitely as tombstones (identifier, org, fingerprint,
`recorded_at`); only the `outcome` payload is nulled after 30 days (FR-006b). A replay beyond the
window returns `IDEMPOTENCY_EXPIRED` rather than silently reprocessing. Deleting the row outright
would make a reused identifier indistinguishable from a new one — the opposite of the stated rule.

The sweep sets `state = 'EXPIRED'` at the same time as it nulls `outcome`. It cannot simply null
`outcome` on a `COMPLETE` row: `CHECK ((state = 'COMPLETE') = (outcome IS NOT NULL))` would reject
the update, so the retention rule as originally written was unexecutable. `EXPIRED` satisfies the
existing CHECK unchanged, because `('EXPIRED' = 'COMPLETE')` and `(NULL IS NOT NULL)` are both
false. A lookup that finds `EXPIRED` answers `IDEMPOTENCY_EXPIRED`; the identifier and fingerprint
survive, so a reused key is still never mistaken for a new one.

Spec: Key Entity "Request Record", FR-006–006c.

---

### `processed_message`

Exactly-once effect for inbound treasury messages (research R4).

| Column | Type | Notes |
|---|---|---|
| `message_id` | `TEXT` PK | From the message envelope |
| `program_id` | `UUID NOT NULL` | |
| `kind` | `message_kind NOT NULL` | `EVENT` or `SNAPSHOT` |
| `version` | `BIGINT NOT NULL` | |
| `content_hash` | `TEXT NOT NULL` | Detects equal-version-differing-content (FR-013b) |
| `processed_at` | `TIMESTAMPTZ NOT NULL` | |

Written in the **same transaction** as the ledger entry it produced. Offset committed only after
that transaction commits.

**Retention**: pruned below the committed offset watermark plus the treasury topic's own retention
window, never on a fixed calendar. Ageing a row out earlier than the broker can redeliver it
re-opens the duplicate window.

---

### `stream_position`

Where the ledger has been applied through — the other half of the recovery source (FR-019d).

| Column | Type | Notes |
|---|---|---|
| `topic` | `TEXT` | PK part |
| `partition` | `INT` | PK part |
| `offset` | `BIGINT NOT NULL` | Last offset whose effect is committed |
| `updated_at` | `TIMESTAMPTZ NOT NULL` | |

### `program_stream_position`

FR-019d requires the applied-through point **per program**, which a partition-keyed row cannot
give: many programs share a partition, so a partition-level gap would otherwise force holding
either every program or none.

| Column | Type | Notes |
|---|---|---|
| `program_id` | `UUID` FK → `program` | PK part |
| `topic` | `TEXT` | PK part |
| `partition` | `INT` | PK part |
| `offset` | `BIGINT NOT NULL` | Last offset applied for **this program** |
| `updated_at` | `TIMESTAMPTZ NOT NULL` | |

Maintained in the same transaction as the ledger entry. On restore, a program whose row is behind
the ledger, or missing where ledger entries exist, has `program.position_verified = FALSE` set;
writes are refused with `POSITION_UNVERIFIED` until a fresh snapshot re-establishes the position
(FR-019e). The hold is per-program, not service-wide.

---

### `snapshot_acknowledgement`

The marker a snapshot carried, retained so the acknowledgement decision is auditable and
reproducible on replay (FR-011a).

| Column | Type | Notes |
|---|---|---|
| `message_id` | `TEXT` PK | FK → `processed_message` |
| `program_id` | `UUID NOT NULL` | |
| `version` | `BIGINT NOT NULL` | |
| `kind` | `ack_kind NOT NULL` | `EXPLICIT` or `WATERMARK` |
| `reservation_references` | `TEXT[] NULL` | Populated when `kind = 'EXPLICIT'` |
| `ingested_through` | `TIMESTAMPTZ NULL` | Populated when `kind = 'WATERMARK'` |

```sql
CHECK ((kind = 'EXPLICIT') = (reservation_references IS NOT NULL))
CHECK ((kind = 'WATERMARK') = (ingested_through IS NOT NULL))
```

`EXPLICIT` matches `invoice_reservation.treasury_reference`; `WATERMARK` acknowledges every local
reservation whose `confirmed_at <= ingested_through`. A marker is only ever applied when the
snapshot's `version` exceeds `acknowledged_by_version`, so an out-of-order marker cannot flag a
reservation an earlier-applied snapshot did not cover.

---

### `fx_rate`

| Column | Type | Notes |
|---|---|---|
| `base_currency`, `quote_currency` | `CHAR(3)` | PK part |
| `effective_at` | `TIMESTAMPTZ NOT NULL` | PK part, ordered last |
| `rate` | `NUMERIC(20,10) NOT NULL` | |
| `source` | `TEXT NOT NULL` | |

Selection is `WHERE base = ? AND quote = ? AND effective_at <= now() ORDER BY effective_at DESC
LIMIT 1`, served by the PK's own index. Read at reservation time only. The rate is **copied onto
the reservation**, so purging or correcting a row here never changes existing reservations'
arithmetic (research R6).

---

## Position derivation

```text
total_reserved  = local_reserved_minor + treasury_reserved_minor
available       = credit_limit_minor − total_reserved        (signed, never floored)
over_limit      = total_reserved > credit_limit_minor
```

**Every write path — without exception — goes through one domain function**,
`advancePosition(program, entries)`, which appends the entries, advances the matching caches from
`program.next_sequence`, re-evaluates `over_limit`, and emits `OVER_LIMIT_ONSET` /
`OVER_LIMIT_CLEARED` when the mark changes. Nothing else writes the `program` row. The mark is
therefore re-evaluated on reserve, release, cancel, treasury event, snapshot **and limit change**
alike — a release that brings the total back inside the limit clears it automatically, as
Constitution III requires.

**Reserve** (program currency amount `A`, under the row lock):
refuse if `position_verified = FALSE` → `POSITION_UNVERIFIED`;
refuse if `over_limit_since IS NOT NULL` → `PROGRAM_OVER_LIMIT`;
refuse if the converted amount rounds to 0 → `AMOUNT_ROUNDS_TO_ZERO`;
refuse if `A > available` → `INSUFFICIENT_CAPACITY`;
else append `+A` LOCAL. The trigger is the backstop, never the primary gate.

**Release** (invoice-currency amount `R`):
`Δ = round_half_up(R × fx_rate)`. Refuse if `Δ > outstanding_reserved_minor` →
`RELEASE_EXCEEDS_RESERVED` — **this check runs on the pre-snap `Δ`**, so an over-release is
refused rather than silently clamped. Only then, if `R = outstanding_invoice_minor` or
`outstanding_reserved_minor − Δ < 1`, snap `Δ := outstanding_reserved_minor` (FR-009b — what
guarantees net-to-zero). Append `−Δ` LOCAL.

**Cancel**: append `−outstanding_reserved_minor` LOCAL, cause `CANCELLATION` or `WRITE_OFF`.

**Incremental treasury event** (`RESERVATION_BOOKED` / `RESERVATION_RELEASED` / `LIMIT_CHANGED`):
deduplicated **by message identity only**. A delta is *never* discarded for being older than the
applied snapshot version — version comparison makes absolute state order-insensitive, but a delta
must apply exactly once regardless of arrival order, and discarding one loses capacity silently
(FR-012a). Events carrying a `reservationReference` this service originated are recognised as an
echo of our own booking and skipped (FR-010a). `LIMIT_CHANGED` appends the signed difference
against the `LIMIT` component.

**Snapshot** (research R5). The snapshot's `reservedMinor` is **inclusive** of local reservations
it acknowledges. The marker is applied **first**, so the sums below reflect this snapshot's own
acknowledgements:

```text
1. apply the acknowledgement marker           → flags matching reservations
2. acked_local   = Σ outstanding_reserved_minor WHERE origin = LOCAL AND treasury_acknowledged
   local_total   = Σ outstanding_reserved_minor WHERE origin = LOCAL
3. target_treasury = snapshot.reservedMinor − acked_local
   target_local    = local_total
4. delta_treasury  = target_treasury − treasury_reserved_minor
   delta_local     = target_local    − local_reserved_minor
   delta_limit     = snapshot.creditLimitMinor − credit_limit_minor
```

Each non-zero delta is appended as its own `RECONCILIATION_ADJUSTMENT` entry against its own
component; zero deltas append nothing. **The delta is decomposed per component rather than dumped
on `TREASURY`**: a single blended delta evaluates to `snapshot.reserved + unacked_local −
local_reserved`, which goes negative whenever the snapshot acknowledges our reservations, aborting
on `CHECK (treasury_reserved_minor >= 0)` and sending every subsequent snapshot for that program
to the DLQ. Decomposed, `target_treasury` reduces to treasury's own booked total and is
non-negative by construction.

`delta_local ≠ 0` means this service's own cache disagrees with its own reservations — a local
bookkeeping defect, not treasury drift. It is applied, and `investigation_required` is set
(FR-019b), so the correction is never silently attributed to treasury.

**Magnitude guard**: a snapshot implying `|delta_treasury| > 50%` of `credit_limit_minor` is
quarantined as `IMPLAUSIBLE_DELTA` for operator review rather than auto-applied (FR-032).

Spec: FR-011, FR-011a, FR-011b.

---

## Indexes

```sql
CREATE INDEX ON program (organisation_id);
CREATE INDEX ON invoice_reservation (program_id, status, created_at DESC);
CREATE INDEX ON invoice_reservation (program_id) WHERE origin = 'LOCAL' AND NOT treasury_acknowledged;
CREATE INDEX ON invoice_reservation (program_id, treasury_reference);
CREATE INDEX ON capacity_ledger_entry (program_id, sequence DESC);
CREATE INDEX ON capacity_ledger_entry (program_id, cause, sequence DESC);
CREATE INDEX ON request_record (recorded_at);      -- outcome-nulling sweep
CREATE INDEX ON processed_message (processed_at);  -- watermark prune
```

The partial index on unacknowledged local reservations exists because R5's sums are computed on
every snapshot — they must not degrade into a full scan of a program's reservations.

Ledger paging is keyed on `sequence DESC`, not `occurred_at`: `sequence` is gapless and totally
ordered per program, so a cursor over it is deterministic on ties. `occurred_at` is retained for
range *filtering* only.
