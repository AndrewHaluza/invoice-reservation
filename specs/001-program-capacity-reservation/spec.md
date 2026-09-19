# Feature Specification: Program Capacity & Invoice Reservation

**Feature Branch**: `001-program-capacity-reservation`

**Created**: 2026-09-19

**Status**: Draft

**Input**: User description: "Program Capacity & Invoice Reservation. A financing program has a total credit limit (e.g. $10,000,000). When an invoice is approved for early payment, it reserves a portion of that capacity. When repaid, the amount is released back. Your task is to implement a module that tracks this in real time — accepting reservations, processing releases, and exposing current availability to clients. Capacity data also flows in from an external treasury system via Kafka, including periodic bulk reconciliation messages that bring a program's full state up to date. Programs and invoices may be denominated in different currencies. All endpoints must be authenticated. The service should be runnable locally. Treat this as production code — if you make assumptions or trade-offs, document them briefly."

## Clarifications

### Session 2026-09-19

- Q: Does a treasury full-state snapshot's reserved figure include reservations this service accepted itself, or only reservations booked directly in treasury? → A: **Inclusive/additive** — the snapshot's reserved figure covers treasury's own bookings *plus* the reservations of ours it acknowledges; on apply, the program's reserved position becomes that figure plus the outstanding of this service's own reservations the snapshot has *not* acknowledged. (Revised 2026-09-19 during design review: the earlier exclusive reading left acknowledged reservations in neither term, so they vanished from the position the moment treasury confirmed them — the same phantom-capacity failure the additive rule exists to prevent, displaced to the far side of the acknowledgement boundary. Inclusivity is also the only reading under which an acknowledgement marker carries information.) Recorded as an explicit trade-off (see Trade-offs).
- Q: The constitution mandates a database constraint that reserved never exceeds the credit limit, while the spec says an over-limit treasury snapshot should be stored and flagged — which gives way? → A: Split the invariant. The database enforces the limit against locally-originated reservations only, and **only in the direction where this service consumes capacity** — a treasury-asserted limit *reduction* below our existing reservations is recorded, not rejected. A treasury-asserted position may exceed the limit; the program is then marked over-limit, new reservations are refused, and operators are alerted. Constitution Principle III requires a corresponding amendment.
- Q: For a cross-currency invoice, is a release amount supplied in the invoice currency or already converted to the program currency, and how is the rounding residual handled? → A: Supplied in the invoice currency and converted at the rate recorded on the reservation, rounded half-up to the program's minor unit. A release settling the invoice's full remaining amount, or leaving less than one minor unit outstanding, releases exactly the remaining reserved amount, so every reservation nets to zero.
- Q: What happens to reserved capacity when an approved invoice is cancelled, voided, or written off rather than repaid? → A: Cancellation is an explicit first-class operation, distinct from release: it returns all remaining reserved capacity and is recorded with its own cause (cancelled or written-off) in the reservation status and the audit trail. Reservations never expire automatically.
- Q: Should clients be able to read back individual reservations and the history of capacity changes, or is current availability the only exposed figure? → A: Both. Callers can list reservations for a program and fetch one by invoice, and can read ledger entries including reconciliation adjustments — all authenticated, scoped to the caller's authorized programs, paged, and filterable by time range and cause.
- Q: When a treasury snapshot corrects a program's position, is the correction written as an adjusting ledger entry, or does the snapshot overwrite the position with a note beside it? → A: Adjusting entry. Applying a snapshot writes a ledger entry whose amount is the difference between the current derived position and the snapshot position, so the position is always the sum of the ledger and replay always reproduces it.
- Q: How does a calling system prove which financing programs it may see and act on? → A: The credential identifies the calling organisation; the service resolves which programs that organisation owns. Programs added later are picked up without reissuing credentials. The service holds the organisation-to-program ownership mapping.
- Q: If the service loses its database, where does it rebuild a program's position from? → A: The recorded ledger is the source of truth. Rebuild by restoring the ledger from backup, then resume consuming the treasury stream from the last position the restored ledger reflects. The stream is never replayed from origin, so the ignore-stale rule is unaffected.
- Q: A caller reuses a request identifier with different content — what happens? → A: Refused as a conflict, distinct from an insufficient-capacity refusal, and nothing changes. An identifier is treated as a retry only when its content matches the original request.
- Q: What should the timestamp accompanying an availability read tell the client? → A: Two distinct facts plus lag — when the position was last changed locally, and what treasury data the figure includes (version and effective time) together with the current stream lag. The "never stale" guarantee is replaced by: a client's own accepted changes are always reflected immediately; treasury changes appear within a stated bound.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Reserve capacity when an invoice is approved (Priority: P1)

An operations system approves an invoice for early payment and asks the capacity service to
reserve the invoice amount against a financing program. The service either confirms the
reservation and reduces available capacity, or rejects it because insufficient capacity remains.
The caller receives the outcome and the program's resulting availability.

**Why this priority**: This is the core money-moving decision. Without it, no invoice can be
funded, and an incorrect answer directly causes over-lending beyond a committed credit limit.

**Independent Test**: Seed a program with a known limit, submit a reservation for part of it,
and confirm the returned availability decreased by exactly the reserved amount and that a
reservation exceeding the remaining capacity is rejected without changing availability.

**Acceptance Scenarios**:

1. **Given** a program with a $10,000,000 limit and no reservations, **When** a $2,000,000
   invoice reservation is submitted, **Then** it is accepted and available capacity is $8,000,000.
2. **Given** a program with $1,000,000 available, **When** a $1,500,000 reservation is submitted,
   **Then** it is rejected with an insufficient-capacity reason and availability stays $1,000,000.
3. **Given** a reservation already accepted for invoice INV-1, **When** the identical request is
   resubmitted, **Then** the original outcome is returned and capacity is not reduced twice.
4. **Given** a reservation already accepted under request identifier R-1, **When** a request
   reusing R-1 with a different amount arrives, **Then** it is refused as a conflict and the
   reserved amount is unchanged.
5. **Given** a program denominated in USD, **When** an invoice denominated in EUR is reserved,
   **Then** the amount is converted at a recorded rate and the converted amount is reserved.
6. **Given** any reservation request without valid credentials, **When** it is submitted,
   **Then** it is refused and no capacity changes.

---

### User Story 2 - Release capacity when an invoice is repaid (Priority: P1)

When a funded invoice is repaid (fully or partially), the reserved amount is released back to
the program so the capacity can be used to fund other invoices.

**Why this priority**: Without release, a program's capacity is consumed permanently and the
program becomes unusable after one cycle. Reserve and release are the same loop.

**Independent Test**: Reserve an amount, release it, and confirm availability returns to its
prior value and a second release of the same repayment does not double-credit.

**Acceptance Scenarios**:

1. **Given** an invoice with $2,000,000 reserved, **When** a full release is processed,
   **Then** availability increases by $2,000,000 and the reservation is marked released.
2. **Given** an invoice with $2,000,000 reserved, **When** a $500,000 partial release is
   processed, **Then** availability increases by $500,000 and $1,500,000 remains reserved.
3. **Given** an invoice with $500,000 remaining reserved, **When** a $900,000 release is
   requested, **Then** it is rejected and no capacity is credited.
4. **Given** a EUR invoice reserved against a USD program, **When** it is repaid in two EUR
   instalments, **Then** each instalment is converted at the rate stored on the reservation and
   the final instalment releases exactly the remaining reserved USD, leaving zero reserved.
5. **Given** a release already processed, **When** the identical release is resubmitted,
   **Then** the original outcome is returned and capacity is not credited twice.

---

### User Story 3 - Cancel a reservation that will never be funded (Priority: P2)

An approved invoice falls through — it is voided upstream, cancelled by the buyer, or written off
as uncollectable. The upstream system cancels the reservation, returning the remaining reserved
capacity to the program so it can fund other invoices.

**Why this priority**: Without it, every failed invoice permanently consumes a slice of the credit
limit. It ranks below the core loop because a cancellation can be worked around manually in the
short term, but the capacity leak is unbounded over time.

**Independent Test**: Reserve an amount, cancel the reservation, and confirm availability returns
to its prior value, the reservation is marked cancelled rather than released, and the audit trail
distinguishes the two.

**Acceptance Scenarios**:

1. **Given** an invoice with $2,000,000 reserved, **When** the reservation is cancelled,
   **Then** availability increases by $2,000,000 and the reservation status is cancelled.
2. **Given** an invoice with $500,000 already repaid of $2,000,000 reserved, **When** the
   remainder is written off, **Then** the remaining $1,500,000 is returned and the audit trail
   shows $500,000 repaid and $1,500,000 written off as separate causes.
3. **Given** a reservation already cancelled, **When** a release is submitted against it,
   **Then** it is rejected and no capacity is credited.
4. **Given** a reservation already cancelled, **When** the identical cancellation is resubmitted,
   **Then** the original outcome is returned and capacity is not credited twice.

---

### User Story 4 - Read current availability and audit history (Priority: P1)

A client queries a program and receives its total limit, currently reserved amount, available
capacity, currency, and the time the figure was current as of.

**Why this priority**: This is the read side that every consuming system depends on; it is also
the only way a caller can make a funding decision before submitting a reservation.

**Independent Test**: After a known sequence of reservations, releases, and cancellations, query the program and
confirm the reported figures equal the arithmetic result of that sequence, and that the ledger
read returns exactly the entries making up that sequence.

**Acceptance Scenarios**:

1. **Given** a program with $10,000,000 limit and $3,000,000 reserved, **When** availability is
   queried, **Then** the response reports limit $10,000,000, reserved $3,000,000, available
   $7,000,000, the program's currency, when the position last changed, and which treasury state
   the figure includes.
2. **Given** a reservation this client accepted moments earlier, **When** availability is
   queried, **Then** the reservation is already reflected, regardless of treasury stream lag.
3. **Given** the treasury stream is lagging, **When** availability is queried, **Then** the
   response reports the lag and the treasury state included, so the client can judge how current
   the figure is.
4. **Given** a request without valid credentials, **When** availability is queried,
   **Then** it is refused.
5. **Given** a program identifier that does not exist, **When** availability is queried,
   **Then** a not-found result is returned without revealing other programs' data.
6. **Given** a program whose availability looks unexpected, **When** its reservations and ledger
   entries are read, **Then** the entries account for the difference between the credit limit and
   the reported availability.
7. **Given** a caller authorized only for program A, **When** it reads reservations or ledger
   entries for program B, **Then** the request is refused and no program B data is disclosed.
8. **Given** a caller granted read-only access, **When** it attempts a reservation, **Then** the
   request is refused on authorization grounds and no capacity changes.

---

### User Story 5 - Apply treasury capacity updates from the event stream (Priority: P2)

The external treasury system publishes capacity events — incremental changes such as a limit
increase or an externally booked reservation. The service applies them to the affected program
so that internally reported availability reflects treasury reality.

**Why this priority**: Without it, the service drifts from the system of record, but the core
reserve/release/read loop is still usable, so this ranks below P1.

**Independent Test**: Publish a limit-change event for a seeded program and confirm the queried
availability changes accordingly; republish the same event and confirm no second effect.

**Acceptance Scenarios**:

1. **Given** a program with a $10,000,000 limit, **When** a treasury event raises the limit to
   $12,000,000, **Then** availability increases by $2,000,000.
2. **Given** a treasury event already applied, **When** the same event is delivered again,
   **Then** it has no additional effect.
3. **Given** a malformed or unparseable treasury message, **When** it is received, **Then** it is
   quarantined for investigation, is not applied, and stream processing continues.
4. **Given** a treasury event referencing an unknown program, **When** it is received,
   **Then** it is quarantined rather than silently discarded.

---

### User Story 6 - Apply bulk reconciliation snapshots (Priority: P2)

The treasury system periodically publishes a full-state snapshot for a program. Applying it
brings the program's limit and reserved position fully up to date, correcting any drift.

**Why this priority**: Reconciliation is the safety net that bounds drift. It matters for
production trust but is not needed to demonstrate the core loop.

**Independent Test**: Drive a program to a known-wrong state, publish a snapshot, and confirm the
program matches the snapshot afterward; then publish an older snapshot and confirm it is ignored.

**Acceptance Scenarios**:

1. **Given** a program showing $3,000,000 reserved, of which $500,000 comes from a local
   reservation the snapshot has not acknowledged, **When** a snapshot states $3,500,000 reserved
   against a $10,000,000 limit, **Then** the program reports $4,000,000 reserved and $6,000,000
   available.
2. **Given** a snapshot already applied at version 12, **When** a snapshot at version 11 arrives,
   **Then** it is ignored and the program is unchanged.
3. **Given** a snapshot is applied, **When** the correction is made, **Then** a compensating
   ledger entry for the difference is written, and replaying the program's ledger from origin
   reproduces the corrected position exactly.
4. **Given** a snapshot arrives concurrently with a reservation on the same program, **When**
   both are processed, **Then** the reservation is retained and counted on top of the snapshot's
   reserved amount, because the snapshot cannot have acknowledged it.
5. **Given** a snapshot carrying no acknowledgement marker, **When** it is received, **Then** it
   is quarantined and the program is unchanged.

---

### Edge Cases

- Two reservations arrive simultaneously and each individually fits the remaining capacity but
  together exceed it: at most the amount that fits is accepted; the other is rejected.
- A reservation exactly equal to remaining capacity: accepted, leaving zero available.
- A zero or negative amount, or an amount with more precision than the currency permits: rejected
  as invalid input.
- An invoice currency for which no conversion rate is available: the reservation is rejected
  rather than guessed.
- A release arrives for an invoice that was never reserved: rejected.
- A cancellation arrives for an invoice that was already fully repaid: rejected, since no reserved
  capacity remains to return.
- A release is denominated in a currency other than the invoice's own currency: rejected as
  invalid input; no implicit third-currency conversion is performed.
- A release arrives out of order, before the reservation it belongs to: rejected; the caller may
  retry after the reservation lands.
- The event stream is unavailable or lagging: reads and reserve/release/cancel continue to operate
  on the last known position, and the lag is reported to clients in the availability response as
  well as to operators.
- A snapshot acknowledges a reservation this service has already fully released: the released
  reservation contributes nothing, and the snapshot's figure is used as-is for it.
- A snapshot would imply reserved exceeding the limit: applied as stated (treasury is the system
  of record), the program is marked over-limit, further reservations are refused, and operators
  are alerted until the position returns within the limit.
- A reservation is submitted against a program currently marked over-limit: refused with an
  over-limit reason, distinct from an ordinary insufficient-capacity refusal.
- A caller authenticated for one program requests another program, including through a
  reservation or ledger read: refused, without revealing whether that program exists.
- A request identifier is reused after its retained outcome has aged out: refused as a conflict,
  never reprocessed as new.
- A caller's organisation owns no programs: list operations return an empty result, and any
  program-specific request is refused as if the program did not exist.
- A program's ownership changes between two requests from the same credential: the second request
  is evaluated against the current mapping, not the mapping in force when the credential was
  issued.
- A ledger read spans a range containing no entries: an empty page is returned, not an error.
- A treasury message asserts a currency other than the program's own: quarantined, never
  converted, and the program is unchanged.
- A snapshot implies no change from the current derived position: no compensating entry is
  written, and the applied version marker still advances.
- The service is restored from a backup older than the current treasury stream position: it
  resumes from the position the restored ledger records and catches up, rather than replaying
  from origin or jumping to the stream head.
- The treasury stream has aged out messages beyond the restored position: the gap is reported to
  operators and the affected programs are held until a fresh snapshot arrives, rather than
  proceeding with a known hole.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST maintain, per financing program, a total credit limit, a currently
  reserved amount, and a derived available amount, each with an explicit currency.
- **FR-002**: System MUST accept a reservation request identifying a program, an invoice, an
  amount, and a currency, and MUST return an accepted or rejected outcome with a reason.
- **FR-003**: System MUST reject a reservation whose amount exceeds the program's available
  capacity, and MUST leave the program position unchanged when it does.
- **FR-004**: System MUST NOT accept a reservation that would cause the program's reserved
  position to exceed its total credit limit at the time of acceptance, including when requests
  arrive concurrently. The sum of reservations originated by this service MUST never exceed the
  limit under any circumstances; a total position exceeding the limit is reachable only through
  treasury-asserted state and is governed by FR-023.
- **FR-005**: System MUST accept release requests for a previously reserved invoice, supporting
  both full and partial release, and MUST track the amount still outstanding in both the invoice
  currency and the program currency.
- **FR-006**: System MUST treat reservation, release, and cancellation requests as idempotent by
  a caller-supplied identifier: a request whose identifier and content both match an earlier one
  returns the original outcome without applying a second effect.
- **FR-006a**: System MUST refuse a request that reuses an identifier with content differing from
  the original, reporting a conflict distinct from an insufficient-capacity or over-limit
  refusal, and MUST apply no effect. Content equality is determined over the fields that
  determine the outcome — program, invoice, amount, and currency.
- **FR-006b**: System MUST retain the outcome recorded against a request identifier for at least
  30 days, and MUST retain the identifier itself — with its owning organisation and content
  fingerprint — indefinitely thereafter, so that a reused identifier is never mistaken for a new
  one. Deleting the record outright would make the two indistinguishable.
- **FR-006c**: System MUST refuse a reused identifier whose outcome is no longer retained,
  reporting an expiry distinct from a content conflict, and MUST apply no effect.
- **FR-006d**: Request identifiers MUST be scoped to the owning organisation. The same identifier
  used by two organisations MUST NOT collide, and MUST NOT under any circumstance replay one
  organisation's outcome to another.
- **FR-006e**: System MUST record a request identifier as in-flight before applying its effect, so
  that two concurrent retries of the same request cannot both apply. The loser MUST be refused as
  retryable, not applied a second time.
- **FR-007**: System MUST expose a query returning a program's total limit, reserved amount,
  available amount, currency, and over-limit state.
- **FR-007a**: The availability response MUST report, as distinct fields, the time the program's
  position last changed, the treasury state version and effective time the figure includes, and
  the current lag between that effective time and the newest message available on the stream.
- **FR-007b**: System MUST reflect a client's own accepted reservation, release, or cancellation
  in any subsequent availability read by that client, with no intervening window in which the
  prior figure is returned.
- **FR-007c**: System MUST reflect a treasury-originated change in availability reads within a
  stated bound of the message becoming available on the stream, and MUST report the lag when that
  bound is exceeded rather than concealing it.
- **FR-008**: System MUST convert an invoice amount into the program's currency when the two
  differ, MUST record the rate and its effective time with the reservation, and MUST reject the
  request when no rate is available.
- **FR-009**: System MUST release an invoice using the exchange rate recorded on the
  reservation, so that reserving and fully releasing an invoice nets to zero regardless of later
  rate movement.
- **FR-009a**: Release amounts MUST be supplied in the invoice's currency. System MUST convert
  them to the program currency at the rate recorded on the reservation, rounding half-up to the
  program currency's minor unit.
- **FR-009b**: When a release settles the invoice's full remaining amount, or when the converted
  amount would leave less than one minor unit of the program currency still reserved, System MUST
  release exactly the remaining reserved amount, so that no residual reserved amount survives a
  fully repaid invoice.
- **FR-009c**: System MUST reject a release whose converted amount exceeds the amount still
  reserved for that invoice, rather than clamping it to the remainder.
- **FR-010**: System MUST consume incremental capacity events from the external treasury stream
  and apply them to the referenced program.
- **FR-010a**: System MUST recognise an incremental event that references a reservation this
  service originated as an echo of its own booking, and MUST NOT apply it. Without this, one
  reservation is counted once as locally-originated and again as treasury-asserted.
- **FR-011**: System MUST consume bulk reconciliation snapshots and bring the referenced program's
  limit to the snapshot's asserted limit **by recording a ledger entry for the difference**. The
  limit, like every other position, MUST be derived from the ledger and MUST NOT be set directly.
- **FR-011c**: System MUST accept a limit reduction that leaves the limit below this service's own
  outstanding reservations. It MUST record the reduction, mark the program over-limit, and refuse
  new reservations — never reject the reduction itself. The treasury system is the system of
  record for the limit; refusing its assertion would leave the service lending against a facility
  that no longer exists.
- **FR-011a**: A snapshot's reserved amount is **inclusive** of the reservations this service
  originated that the snapshot acknowledges, together with treasury's own bookings. On applying a
  snapshot, the program's reserved position MUST become that amount plus the total outstanding of
  this service's reservations the snapshot has *not* acknowledged. Acknowledgement is determined
  by the marker the snapshot carries: a set of reservation references, or a watermark instant.
- **FR-011d**: System MUST apply the acknowledgement marker **before** computing the totals the
  correction is derived from. The two orderings differ by exactly the amount newly acknowledged.
- **FR-011e**: System MUST durably record the acknowledgement marker a snapshot carried, so the
  decision is auditable and reproducible on replay, and MUST NOT apply a marker from a snapshot
  older than the one that last acknowledged a given reservation.
- **FR-011f**: System MUST record the correction as **separate entries per position component** —
  the treasury-attributable part and the locally-attributable part — rather than as one blended
  entry. A blended correction can drive the treasury component negative whenever a snapshot
  acknowledges this service's reservations, which would abort the snapshot permanently.
- **FR-011g**: A non-zero locally-attributable correction means this service's own records
  disagree with each other. System MUST apply it and mark the program for investigation, rather
  than attributing the discrepancy to the treasury system.
- **FR-011b**: System MUST quarantine a snapshot that carries no acknowledgement marker, because
  the additive rule in FR-011a cannot be applied safely without one.
- **FR-012**: System MUST ignore a **reconciliation snapshot** that is older than the state
  already applied for that program, determined by a version or effective time carried on the
  message. A snapshot asserts absolute state, so a superseded one carries no information.
- **FR-012a**: System MUST NOT discard an **incremental event** for being older than the applied
  state. An incremental event asserts a change, not a state, and must take effect exactly once
  regardless of arrival order. Deduplication for incremental events is by message identity alone.
  Discarding a late delta silently loses capacity, with no quarantine record and no alert.
- **FR-013**: System MUST achieve exactly-once effect for each treasury message under
  at-least-once delivery, so that duplicate delivery does not change the position twice and no
  accepted message goes unapplied.
- **FR-013a**: System MUST apply duplicate suppression by message identity first, and evaluate
  the staleness rule in FR-012 only for snapshots that survive it.
- **FR-013b**: System MUST quarantine a message whose version or effective time equals the state
  already applied but whose content differs, rather than choosing between them.
- **FR-013c**: System MUST quarantine a treasury event or snapshot whose currency does not match
  the program's denomination currency, and MUST NOT convert it.
- **FR-013d**: A program's denomination currency is immutable once established; System MUST
  quarantine any message that would change it, because existing reservations hold conversions
  against that currency.
- **FR-014**: System MUST route messages it cannot parse, validate, or apply to a quarantine
  destination for operator investigation, and MUST continue processing subsequent messages.
- **FR-015**: System MUST record every change to a program's position — reservation, release,
  cancellation, write-off, treasury event, limit change, and reconciliation adjustment — as an
  immutable, attributable entry that can be replayed to reconstruct the current position.
  Corrections MUST be expressed as compensating entries; editing or deleting an existing entry is
  prohibited.
- **FR-016**: System MUST reject unauthenticated requests to every endpoint.
- **FR-017**: System MUST derive a caller's authorized programs from the organisation identified
  by its credential, using an ownership mapping the service holds, and MUST NOT disclose the
  existence or figures of programs outside that scope.
- **FR-017a**: A program newly associated with an organisation MUST become accessible to that
  organisation's existing credentials without reissuing them, and a program disassociated from an
  organisation MUST become inaccessible on the next request.
- **FR-017b**: System MUST distinguish the permission to read a program's position from the
  permission to reserve, release, or cancel against it, so that a reporting client can be granted
  read access without the ability to move capacity.
- **FR-018**: System MUST validate all inbound request and message payloads and reject invalid
  amounts, unknown currencies, and unknown identifiers with a specific, non-leaking reason.
- **FR-019**: System MUST apply a reconciliation snapshot as a compensating ledger entry whose
  amount is the difference between the program's currently derived position and the position the
  snapshot implies under FR-011a. System MUST NOT overwrite a program's position directly.
- **FR-019a**: Every one of a program's reported positions — reserved **and credit limit** — MUST
  at all times equal the sum of its ledger entries for that component, so that replaying the
  ledger from origin reproduces the reported figures exactly.
- **FR-019b**: System MUST continuously verify that the total outstanding of this service's
  active reservations equals the locally-originated component of the program's reserved position.
  On mismatch, System MUST alert operators and mark the program as requiring investigation, and
  MUST NOT silently self-correct.
- **FR-019f**: The verification in FR-019b MUST run as a scheduled service component, MUST emit
  its result as an operational metric, and its finding MUST be visible to an authorized caller on
  the availability response. A check whose result no one can observe is not a check.
- **FR-019c**: System MUST treat its own ledger as the source of truth for recovery. Rebuilding a
  program's position MUST restore the ledger and resume treasury consumption from the last stream
  position that ledger reflects, and MUST NOT reconstruct a position by replaying the treasury
  stream from origin.
- **FR-019d**: System MUST durably record, alongside the ledger, the treasury stream position
  applied through for each program, so that consumption can resume at exactly that point after a
  restore without reapplying or skipping messages.
- **FR-019e**: System MUST refuse to serve reservation, release, or cancellation requests for a
  program whose ledger has been restored but whose treasury stream position is not yet known,
  rather than serving a position it cannot vouch for.
- **FR-020**: System MUST expose operational health and staleness signals, including how far
  behind the treasury stream the service currently is.
- **FR-021**: System MUST be startable on a developer machine with a documented single command
  and seeded sample data, with no access to external production systems required.
- **FR-022**: System MUST publish the assumptions and trade-offs taken during implementation in a
  short written document delivered with the service.
- **FR-023**: When a treasury event or snapshot brings a program's total reserved position above
  its credit limit, System MUST record the position as asserted, mark the program over-limit,
  refuse all new reservations against it while that condition holds, and raise an operator alert.
- **FR-029**: System MUST allow an authorized caller to list the reservations for a program and
  to fetch a single reservation by invoice identifier, with paging, and MUST scope results to the
  programs the caller is authorized for.
- **FR-030**: System MUST allow an authorized caller to read a program's ledger entries,
  including reconciliation adjustments and over-limit onset and clearance entries, with paging
  and filtering by time range and by cause.
- **FR-031**: System MUST return ledger entries in a stable, deterministic order such that
  reading them in sequence and applying them reproduces the program's reported position. Ordering
  MUST be by the entries' own per-program sequence, which is gapless and total, rather than by
  their timestamps, which can tie.
- **FR-032**: System MUST quarantine a reconciliation snapshot implying a treasury correction
  larger than a configured proportion of the program's credit limit, for operator review rather
  than unattended application. A single malformed or forged snapshot MUST NOT be able to move a
  facility's whole position without a human seeing it.
- **FR-033**: System MUST rate-limit inbound requests per calling organisation, across both reads
  and writes, and MUST report refusals with a retry hint. One organisation's traffic MUST NOT be
  able to deny service to another's, whether by exhausting capacity to serve requests or by
  monopolising contention on a single program.
- **FR-034**: System MUST authenticate the treasury message stream at the transport layer and
  MUST accept capacity messages only from the treasury system's own authorized identity. Message
  schema validation establishes that a message is well-formed, never that it is authentic: an
  unauthenticated stream lets anyone able to reach the broker assert an arbitrary position on any
  program without presenting a credential to this service at all.
- **FR-035**: System MUST classify a failure to apply a treasury message as transient or
  permanent. A transient failure MUST be retried without advancing the stream position; only a
  message that can never apply may be quarantined. Quarantining transient failures drifts every
  affected position silently while the service reports itself healthy.
- **FR-036**: System MUST restrict read access to the quarantine destination to operations
  tooling, and MUST route replayed messages through the ordinary validation and deduplication
  path rather than a privileged bypass.
- **FR-025**: System MUST allow an authorized caller to cancel an active reservation, returning
  all of its remaining reserved capacity to the program.
- **FR-026**: System MUST record a cancellation with a distinct cause (cancelled or written-off)
  separate from repayment-driven release, in both the reservation status and the ledger, so that
  an audit can tell why capacity was returned.
- **FR-027**: System MUST reject any further release or cancellation against a reservation that
  is already fully released or cancelled, and MUST treat repeated identical cancellations
  idempotently per FR-006.
- **FR-028**: System MUST NOT expire or release a reservation automatically through the passage
  of time; capacity is returned only by an explicit release or cancellation, or by treasury
  reconciliation.
- **FR-024**: System MUST clear a program's over-limit mark automatically once its total reserved
  position returns to or below the credit limit, and MUST record both the onset and the clearance
  as auditable entries.

### Key Entities

- **Owning Organisation**: The party a financing program belongs to. Holds an identifier and the
  set of programs it owns; a caller's credential identifies exactly one such organisation.
- **Financing Program**: A committed credit facility. Holds an identifier, its owning
  organisation, a total credit limit,
  a denomination currency, the reserved amount split into locally-originated and
  treasury-originated components, an over-limit mark, the last treasury state version applied,
  and a last-updated time.
- **Invoice Reservation**: A claim on a program's capacity for a specific invoice. Holds the
  program, the invoice identifier, the original invoice amount and currency, the amount reserved
  in program currency, the conversion rate and its effective time when currencies differ, the
  amount still outstanding in both the invoice currency and the program currency, and a status
  (active, partially released, fully released, cancelled, written-off).
- **Stream Position Marker**: The point in the treasury stream a program's ledger has been
  applied through. Durably recorded with the ledger and used to resume consumption after a
  restore.
- **Request Record**: The recorded outcome of a caller request, keyed by its request identifier.
  Holds the identifier, the outcome-determining content of the original request, the outcome
  returned, and the time recorded; retained for at least 30 days.
- **Capacity Ledger Entry**: An immutable record of one change to a program's position. Holds the
  program, the change amount and direction, the cause (reservation, release, cancellation,
  write-off, treasury event, reconciliation adjustment), the originating identifier, the actor,
  and the time.
- **Treasury Capacity Event**: An inbound incremental change from the external treasury system.
  Holds the program, the change it asserts, a version or effective time, and a message identity
  used for duplicate detection.
- **Reconciliation Snapshot**: An inbound full-state assertion for one program. Holds the
  program, the asserted limit and treasury-originated reserved amount with currency, a version or
  effective time, and an acknowledgement marker identifying which of this service's reservations
  the asserted amount already includes.
- **Exchange Rate**: A conversion between two currencies at a point in time. Holds the currency
  pair, the rate, its effective time, and its source.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Across 1,000 concurrent reservation attempts against a single program, the total
  amount accepted never exceeds the program's credit limit, in 100% of 20 consecutive runs.
- **SC-001a**: While a program is marked over-limit, 100% of reservation attempts against it are
  refused, and the mark clears automatically within one position change of the total returning
  within the limit.
- **SC-002**: A reservation, release, or cancellation accepted for a client is reflected in that
  client's next availability query 100% of the time, across 10,000 trials.
- **SC-002a**: A treasury-originated change is reflected in availability reads within 5 seconds
  of the message becoming available on the stream, at the 99th percentile; when that bound is
  exceeded, the reported lag exceeds 5 seconds in 100% of cases rather than the staleness being
  concealed.
- **SC-003**: 95% of availability queries return in under one second at 200 concurrent clients.
- **SC-003a**: 95% of reservation requests contending on a single program complete in under two
  seconds at 50 concurrent writers, with no request failing due to contention alone.
- **SC-004**: Replaying every recorded position change for a program reproduces the program's
  reported position exactly, for every program, on every audit run.
- **SC-004a**: Every fully repaid invoice, cross-currency or not, leaves exactly zero reserved
  against its program — no residual minor units — in 100% of cases.
- **SC-004b**: An auditor with only an authenticated client, and no database access, can read a
  program's ledger and reproduce its reported position exactly, for every program.
- **SC-004c**: After any sequence of reservations, releases, cancellations, treasury events, and
  snapshots, the total outstanding of active reservations equals the locally-originated component
  of the program's reserved position, in 100% of cases; any divergence raises an alert rather
  than being corrected silently.
- **SC-005**: Duplicate delivery of any reservation, release, cancellation, or treasury message
  changes the reported position in 0% of cases, and a reused request identifier carrying
  different content is refused in 100% of cases.
- **SC-006**: After a reconciliation snapshot is applied, the program's reported figures match the
  position the snapshot implies in 100% of cases, and every applied snapshot that implies a
  non-zero difference has a recorded difference entry for each component it moved. A snapshot
  implying no change records no entry and advances only the applied-version marker.
- **SC-007**: Unauthenticated requests are refused on 100% of endpoints, verified by an automated
  check that enumerates the service's endpoints.
- **SC-007a**: Cross-program access attempts are refused on 100% of endpoints that accept a
  program identifier, verified by an automated check, and the refusal does not reveal whether the
  requested program exists.
- **SC-008**: A reviewer starting from a clean clone has the service running, seeded, and serving
  an availability query in under 10 minutes following the written instructions.
- **SC-009**: Every message the service cannot apply is retrievable from the quarantine
  destination, with 0% of such messages lost or silently dropped.
- **SC-010**: Restoring the service from a ledger backup and resuming the stream reproduces every
  program's position exactly, with no reservation lost and no treasury message applied twice, in
  100% of recovery drills.

## Trade-offs

- **The `reserved <= limit` invariant is enforced in the database against locally-originated
  reservations only.** Chosen so that a treasury-asserted over-limit position is preserved and
  surfaced rather than rejected at the door — treasury is the system of record and losing that
  signal is worse than storing an uncomfortable number. The cost: the database no longer
  guarantees the headline invariant on the total position, so over-limit becomes an operational
  state that must be detected, alerted, and cleared rather than a structural impossibility.
  Constitution Principle III was amended accordingly in version 2.0.0; the spec and the
  constitution now agree.

- **Snapshot reserved is treated as inclusive of the reservations it acknowledges, additive over
  those it does not.** The treasury stream will always lag, so a snapshot applied as a bare
  overwrite would erase in-flight local reservations while their invoices remain funded, producing
  phantom capacity. Adding unacknowledged local reservations on top prevents that. The figure must
  be *inclusive* of what it does acknowledge, because an exclusive reading leaves an acknowledged
  reservation in neither term — it disappears from the position the instant treasury confirms it,
  which is the same phantom-capacity failure moved to the far side of the acknowledgement
  boundary. The cost: correctness depends on the treasury producer emitting a reliable
  acknowledgement marker on every snapshot. If that marker is absent, late, or wrong, a
  reservation can be counted twice and the program will under-report availability. FR-011b
  quarantines unmarked snapshots rather than guessing, and FR-032 holds implausibly large
  corrections for a human. Revisit if treasury can guarantee its snapshots are emitted strictly
  after every reservation it has ingested, which would let the marker be dropped entirely.

- **Availability can be over-reported between a release and the next snapshot.** A snapshot
  acknowledging a reservation we have since released reinstates its amount until the following
  snapshot corrects it — potentially hours, and unbounded in magnitude. Accepted rather than
  solved, because solving it means the snapshot must be reconciled against our release history
  rather than applied as asserted state. Surfaced instead: the availability response carries
  `reconciliationPending` so a client can see the figure is known to be conservative, rather than
  discovering it by arithmetic.

- **Partitioning the ledger was dropped rather than deferred.** Monthly range partitioning is
  incompatible with the gapless per-program sequence the audit guarantee rests on, and dropping a
  partition would permanently falsify `position = Σ ledger`. Retrofitting partitioning onto a
  large ledger later is a real migration with real risk. Accepted knowingly: at the stated scale
  that migration is years away, and a partitioning scheme that breaks the ledger's arithmetic is
  worse than no partitioning at all.

## Assumptions

- A financing program's credit limit and currency are provided by the treasury system or seeded
  administratively; this service does not offer an endpoint to create or edit programs.
- Callers are machine clients (internal services), not interactive end users; authentication is
  token-based, and each token identifies one owning organisation (see FR-017).
- The organisation-to-program ownership mapping is maintained alongside the programs themselves,
  by the same administrative or treasury-driven path that establishes a program; this service
  offers no endpoint to edit it.
- Reserve, release, and cancel are invoked by an upstream approval, repayment, and exceptions
  system; this service does not decide whether an invoice should be funded or written off, only
  whether capacity exists and what its current position is.
- Exchange rates are obtained from a single configured rate source and cached with an effective
  timestamp; the rate is captured at reservation time and reused for every release against that
  reservation, so no revaluation of existing reservations occurs. Revaluation is out of scope.
- Rounding is half-up to the program currency's minor unit; the residual this creates on
  cross-currency partial releases is absorbed by the final release (FR-009b).
- The treasury stream retains messages long enough to cover the gap between a backup and a
  restore; if it does not, affected programs are held pending a fresh snapshot rather than served
  from an incomplete position.
- The treasury system is the system of record for a program's limit; on conflict, its snapshot
  wins over the internally derived position. For the reserved position it is the system of record
  only for reservations it originated — see FR-011a and Trade-offs.
- Treasury messages carry a message identity and a version or effective time; without these,
  ordering and duplicate suppression cannot be guaranteed and such messages are quarantined.
- A program's denomination currency is fixed for the life of the program; re-denomination, if it
  ever occurs, is handled by retiring the program and establishing a new one, and is out of scope.
- Ordering is guaranteed only per program, via the message key; no global ordering is assumed.
- Amounts are handled in currency minor units, and partial release is supported because invoices
  are commonly repaid in instalments.
- A program's capacity has no expiry, tranche, or term structure; a single flat limit per program
  is assumed for this scope.
- Clients are expected to treat a reported treasury lag as an input to their own risk decision;
  this service does not refuse reads or reservations solely because the stream is behind.
- Local operation depends on a containerized database and message broker running alongside the
  service; no external network dependency is required to run or test it.
