# Execution Plan: Phase 8 — Apply bulk reconciliation snapshots (User Story 6, P2)

## Goal

A periodic full-state assertion from treasury brings a program up to date **as compensating ledger
entries**, without erasing reservations treasury has not yet seen, without blending the correction
into a single delta that can drive a component negative and freeze the program, and without
arbitrating a snapshot whose version collides with different content.

## Preconditions

**Phase 7 is not merged as of this writing.** This plan is written against the state it leaves
behind. Re-verify each fact below by reading the repository; if any is false, stop.

- Phase 7 has landed: the consumer, schema validation, retry classification, DLQ and
  `processed_message` dedupe exist and are shared by this phase.
- `snapshot_acknowledgement` exists: PK `message_id`, plus `program_id`, `version`,
  `kind ('EXPLICIT'|'WATERMARK')`, `reservation_references text[]`, `ingested_through timestamptz`.
  Nothing writes it yet.
- `invoice_reservation.treasury_acknowledged`, `acknowledged_by_version`, `treasury_reference` and
  `confirmed_at` all exist.
- `program.investigation_required` and `position_verified` exist; phase 5 already reports them.
- `advancePosition` appends the `OVER_LIMIT_ONSET` / `OVER_LIMIT_CLEARED` entry automatically when
  `local + treasury > limit` flips — the over-limit mark is not this phase's to set by hand.
- The over-limit state must **tolerate** `total > limit`. A plain `CHECK` constraint would abort the
  limit-reduction transaction; confirm the migration's trigger `WHEN` clause permits it (T083).

## Target State

- A snapshot decomposes into **per-component** corrections, each its own
  `RECONCILIATION_ADJUSTMENT` entry, and **no entry at all for a zero delta**.
- `target_treasury = snapshot.reservedMinor − acked_local`; `target_local = local_total`.
- A snapshot whose marker acknowledges more than its own reported reserved total
  (`acked_local > snapshot.reservedMinor`) is **quarantined**, not applied.
- The acknowledgement marker is applied **before** the sums are computed.
- A snapshot older than the applied version is ignored; an equal-version-differing-content snapshot
  is quarantined `VERSION_CONFLICT`, never arbitrated.
- A limit reduction below this service's own reservations is **applied**, the program goes
  over-limit, and the mark clears automatically once releases bring the total back inside.

## Scope

### In Scope

- `src/treasury/handlers/reconciliation-snapshot.handler.ts` (T085)
- `src/capacity/domain/policies/apply-snapshot.policy.ts` (T086)
- `src/capacity/application/apply-snapshot.service.ts` (T087, T088, T089)
- Tests T080–T084
- Closing out the two `it.todo` DLQ cases phase 7 deferred here (Task 11)
- One contract question to ratify before coding (Task 0)

### Out of Scope

- The scheduled reconciliation verifier and recovery detection (phase 9).
- Any new consumer, DLQ or dedupe mechanism — phase 7's are reused.
- Self-correction of any kind: this phase flags, it never silently fixes.

## Key Decisions

0. **The snapshot is applied as compensating ledger entries and nothing else (FR-011, FR-011a,
   FR-019, FR-019a).** Every reported figure stays reconstructible by summing entries per
   component; no code in this phase writes a position column directly. The lettered rules below are
   how that parent requirement is honoured.
1. **Marker first, then sums (FR-011d).** Applying the acknowledgement marker before computing
   `acked_local` and `local_total` versus after differs by exactly the amount newly acknowledged.
   The ordering is the requirement, not an implementation detail. T082 asserts it directly.
2. **One entry per non-zero component delta, never a blended delta (FR-011f).** A single blended
   adjustment drives the `TREASURY` component negative in the acknowledged case and freezes the
   program permanently. T081 exists to prevent exactly that.
3. **A non-zero locally-attributable correction sets `investigation_required` (FR-011g)** — it means
   this service's own records disagree with treasury's. It is never absorbed into the treasury
   column to make the arithmetic close.
4. **A snapshot with no acknowledgement marker is quarantined `MISSING_ACK_MARKER` (FR-011b)** —
   without it, `snapshot.reservedMinor` cannot be decomposed and applying it would erase in-flight
   local reservations.
5. **Equal version, differing content → `VERSION_CONFLICT`, never a winner (FR-013b).** Two
   different truths at the same version is a producer defect; arbitrating it would encode a guess as
   ledger history.
6. **The applied-version marker advances even on a zero-delta snapshot, while no entry is written**
   (T080). Progress and effect are separate facts.
7. **Limit reductions are applied, not refused (FR-011c).** Treasury owns the limit. The program
   going over-limit is the correct, visible consequence; refusing would leave the two systems
   disagreeing about the limit itself.
8. **⚠ A negative `target_treasury` is an inconsistent snapshot. The proposed answer is to
   quarantine it `SNAPSHOT_INCONSISTENT` — but that reason code is NOT yet ratified.**
   `contracts/errors.md` carries the quarantine reason set (`SCHEMA_INVALID`, `UNKNOWN_PROGRAM`,
   `CURRENCY_MISMATCH`, `MISSING_ACK_MARKER`, `VERSION_CONFLICT`, `IMPLAUSIBLE_DELTA`,
   `LIMIT_BELOW_LOCAL`, `HANDLER_FAILURE`) and states codes are part of the contract, additive-only.
   Adding a code is therefore permitted but must be done **in the contract first** — Task 0 below,
   which is a stop-and-ask, not an executor edit. The spec is genuinely silent on this case
   (FR-011g governs local-vs-local disagreement, not a snapshot disagreeing with its own marker),
   so the reason is new ground rather than a misuse of an existing code.

   The reasoning for refusing: `target_treasury` is only non-negative when treasury's reported
   `reservedMinor` genuinely includes every reservation its marker acknowledges. A lagging or
   malformed snapshot where `acked_local > snapshot.reservedMinor` yields a negative target and
   would write a negative `TREASURY` component — the exact freeze this phase exists to prevent,
   arriving through arithmetic instead of through blending. The FR-032 magnitude guard does not
   catch it: a small inconsistency passes under any sane proportion. Check
   `target_treasury >= 0n` explicitly in the policy and refuse; the decomposition is only valid
   under that invariant.
9. **The FR-032 magnitude guard quarantines, it does not clamp.** It is scoped to `|delta_treasury|`
   deliberately: FR-032 speaks of a "treasury correction", and FR-011f already splits the components,
   so `delta_local` (which raises `investigation_required`) and `delta_limit` (which treasury owns
   outright) are out of its scope. A snapshot implying
   `|delta_treasury|` above the configured proportion of the credit limit goes to
   `IMPLAUSIBLE_DELTA` for operator review.
10. **The marker is persisted to `snapshot_acknowledgement` (FR-011e)** so the decision is auditable
   and reproducible on replay — a marker held only in memory makes the ledger unexplainable.

## Execution Order

### Task 0: Ratify the `SNAPSHOT_INCONSISTENT` reason — STOP AND ASK

Do not write code for this task. The negative-`target_treasury` case (Key Decision 8) needs a
quarantine reason that `contracts/errors.md` does not yet define. Put the choice to whoever owns
the contract:

- **(A)** Add `SNAPSHOT_INCONSISTENT` to `contracts/errors.md` as an additive quarantine reason,
  then proceed as this plan describes.
- **(B)** Reuse `SCHEMA_INVALID` on the grounds that a snapshot contradicting its own marker is
  malformed, and add no code.
- **(C)** Apply it rather than quarantining, clamping `target_treasury` at zero and setting
  `investigation_required`. **This plan argues against (C)**: it books a correction nobody can
  explain from the snapshot, which is what FR-011f and FR-019a exist to prevent.

Whichever is chosen, the contract and this plan must agree **before** Task 6 lands. An executor
must not invent the code on its own.

### Task 1: `test/integration/stale-reconciliation.spec.ts` (T080) — MANDATORY (Constitution VI), WRITE FIRST

- A snapshot older than the applied version is ignored and changes nothing (no entry, no flag).
- An equal-version-differing-content snapshot is quarantined `VERSION_CONFLICT`.
- A zero-delta snapshot advances the applied-version marker **while writing no ledger entry**
  (SC-006, FR-012).

### Task 2: `test/integration/snapshot-decomposition.spec.ts` (T081) — WRITE FIRST

The case from the user story: reserve 500,000 locally; apply a snapshot asserting 3,500,000 reserved
with a watermark predating the reservation. Assert total reads 4,000,000 and the adjustment lands on
the `TREASURY` component alone. Add the inconsistency case: a snapshot whose marker acknowledges
more than its own `reservedMinor` is quarantined `SNAPSHOT_INCONSISTENT` and writes nothing —
assert no negative `TREASURY` entry exists. Then the acknowledged variant: `target_treasury` is **non-negative**;
corrections land per component; a non-zero local correction sets `investigation_required` rather than
being absorbed. Assert explicitly that **no single blended entry** exists.

### Task 3: `test/integration/ack-marker.spec.ts` (T082) — WRITE FIRST

- An `EXPLICIT` marker matches `treasury_reference`.
- A `WATERMARK` marker acknowledges reservations whose `confirmed_at <= ingestedThrough`.
- The marker is applied **before** the sums (assert via a case where the two orderings give
  different results, and the expected value is the marker-first one).
- A marker from a snapshot older than `acknowledged_by_version` is **not applied** to that
  reservation (FR-011e): it neither sets the acknowledgement flag nor contributes to `acked_local`.
  The rest of the snapshot still proceeds — a stale marker skips one reservation, it does not
  invalidate the message.

### Task 4: `test/integration/limit-reduction.spec.ts` (T083) — WRITE FIRST

Treasury cuts the limit below this service's own reservations: the change is **applied**, the
program is marked over-limit with an `OVER_LIMIT_ONSET` entry, and the mark clears automatically
(`OVER_LIMIT_CLEARED`) once releases bring the total back within the limit (FR-011c, SC-001a).
If a `CHECK` constraint aborts this transaction, the migration's trigger `WHEN` clause is wrong —
report it as a blocker rather than relaxing the test.

### Task 5: `test/integration/over-limit.spec.ts` (T084) — WRITE FIRST

While over-limit, **100%** of new reservations are refused `PROGRAM_OVER_LIMIT`; onset and clearance
are both recorded as ledger entries (SC-001a, FR-023, FR-024).

### Task 6: The snapshot handler (T085)

`src/treasury/handlers/reconciliation-snapshot.handler.ts`: validation → identity dedupe → version
comparison → `MISSING_ACK_MARKER` quarantine → dispatch. **Dispatch only; no transaction, no
aggregate write** (plan.md's second dependency rule, same as phase 7's event handler).

### Task 7: The snapshot policy (T086)

`src/capacity/domain/policies/apply-snapshot.policy.ts`, pure, computing **in this order**:

1. apply the acknowledgement marker to the reservation set;
2. `acked_local` (sum of `outstanding_reserved_minor` over acknowledged reservations) and
   `local_total` (sum over all active reservations);
3. `target_treasury = snapshot.reservedMinor − acked_local`; `target_local = local_total`;
   **refuse `SNAPSHOT_INCONSISTENT` when `target_treasury < 0n`** — the decomposition's validity
   depends on that invariant (Key Decision 8);
4. `delta_treasury = target_treasury − program.treasuryReservedMinor`,
   `delta_local = target_local − program.localReservedMinor`,
   `delta_limit = snapshot.creditLimitMinor − program.creditLimitMinor`.

Return the three deltas plus `investigationRequired = delta_local !== 0n`. The policy takes plain
readonly inputs and performs no I/O.

### Task 8: The apply service (T087)

`src/capacity/application/apply-snapshot.service.ts` owns the transaction and the row lock:

- `withProgramLock` → insert `processed_message` in the same transaction → run the policy;
- append **one `RECONCILIATION_ADJUSTMENT` entry per non-zero component delta**, and none for a zero
  delta; `advancePosition` then `persistAdvance`;
- persist the marker to `snapshot_acknowledgement` and set `acknowledged_by_version` /
  `treasury_acknowledged` on the acknowledged reservations;
- set `investigation_required` when the policy says so — and never clear it here;
- write `program_stream_position` in the same transaction.

### Task 9: The magnitude guard (T088)

In the same service, before applying: if `|delta_treasury|` exceeds the configured proportion of the
credit limit, quarantine `IMPLAUSIBLE_DELTA` and apply nothing. The proportion is the env var added
in phase 7's Task 1.

### Task 10: `reconciliationPending` (T089)

Set when an applied snapshot acknowledged a reservation that has since been released, so a client
sees that the reported figure is known to be conservative instead of discovering it by arithmetic
(spec.md Trade-offs). Phase 5 already reports the flag; this task gives it a writer.

### Task 11: Close phase 7's deferred DLQ cases

Phase 7's `test/integration/dlq.spec.ts` left `MISSING_ACK_MARKER` and `IMPLAUSIBLE_DELTA` as
`it.todo` because no snapshot handler existed then. Both now exist (Tasks 6 and 9). Replace the two
`it.todo` entries with real assertions, and add the reason ratified in Task 0. Leaving an `it.todo`
behind is how a quarantine reason ends up with no test at all.

Verification: `grep -rn "it.todo" test/` returns nothing for the DLQ spec.

## Final Verification

```bash
./scripts/dev-stack.sh env
docker compose down -v && docker compose up -d
npm run migration:run && npm run seed
npm run lint && npm run typecheck && npm test && npm run test:cov && npm run build
npm run audit:ledger
```

Expected: all five phase-8 integration specs pass; `npm run audit:ledger` still reconciles every
component after snapshots have been applied — if it does not, the decomposition wrote a delta the
ledger cannot explain, which is a stop condition, not a tuning exercise.

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

Changing the decomposition arithmetic, the marker-then-sums ordering, or any quarantine reason is a
**stop-and-re-plan** condition. When stopping, report: the task number, the exact blocker, the
evidence, the invalid assumption, and the minimum planning decision required to continue.
