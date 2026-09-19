# Specification Quality Checklist: Program Capacity & Invoice Reservation

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-19
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Validation pass 4 (second `/speckit-clarify`, 2026-09-19): five further clarifications —
  snapshot applied as compensating ledger entry, organisation-based authorization, ledger-as-
  recovery-source, idempotency conflict on identifier reuse, and dual timestamps with reported
  treasury lag. Mechanical review fixes also applied: exactly-once wording and FR-012/FR-013
  precedence, inbound currency-mismatch quarantine, immutable program currency, write-path
  contention criterion. FR count 31 → 52, SC count 13 → 17.
- All CRITICAL and HIGH findings from the spec review are now closed. C2 (derived vs set
  position) closed by FR-019/019a; H6 (reservation/ledger divergence) by FR-019b and SC-004c;
  H3 by SC-002/002a; H4 by FR-007a; H5 by FR-013c/013d.
- Validation pass 3 (post-`/speckit-clarify`, 2026-09-19): five clarifications integrated —
  snapshot reserved semantics (additive), over-limit invariant split, cross-currency release
  arithmetic, explicit cancellation, and audit read access. New sections: Clarifications,
  Trade-offs. New user story (cancellation). FR count 22 → 31.
- RESOLVED (2026-09-19): the over-limit conflict with Constitution Principle III was closed by
  constitution v2.0.0, which scopes the mandatory database constraint to locally-originated
  reservations and adds the over-limit state obligations. Spec and constitution now agree.
- Validation pass 5 (post design review, 2026-09-19): four parallel review agents (architecture,
  security, database/contracts, traceability) audited the Phase 0/1 artifacts. They found two
  blockers confirmed independently by three reviewers each, and three arithmetic defects in the
  core design. All are now closed:
  - Ledger `UNIQUE (program_id, sequence)` could not coexist with `PARTITION BY RANGE
    (occurred_at)` — PostgreSQL rejects it. Partitioning removed (research R8).
  - `request_record` PK was `request_id` alone while its own prose claimed org scoping —
    cross-tenant outcome replay. Now `(organisation_id, request_id)`; FR-006d/006e added.
  - `CHECK (local_reserved_minor <= credit_limit_minor)` aborted treasury limit *reductions*.
    Replaced by a trigger bound to the increasing direction; FR-011c added; constitution
    amended to v2.1.0.
  - The credit limit was set directly rather than derived, breaking Constitution II and making
    SC-004b structurally false. Now a `LIMIT` ledger component (FR-011, FR-019a).
  - The snapshot delta was applied wholly to the treasury component and could go negative,
    permanently freezing reconciliation. Now decomposed per component (FR-011f/011g).
  - Version staleness was applied to incremental events, silently discarding late deltas.
    Staleness now applies to snapshots only (FR-012a).
  - The treasury topics had no producer authentication of any kind (FR-034), and no rate
    limiting existed anywhere (FR-033). Both added; constitution Principle V extended.
  SC-006 contradicted three other artifacts on the zero-delta snapshot and was rewritten.
  `CURRENCY_MISMATCH` was 400 in errors.md and 409 in the OpenAPI; now 409 in both.
  FR count 52 → 68.
- CORRECTED (2026-09-19): the plan's Constitution Check table claimed PASS on all seven
  principles. Three rows were not backed by the artifacts. II and III are now PASS only after
  the corrections above; VI is marked DEFERRED with a named gate, and Complexity Tracking is no
  longer empty. A gate that passes itself is not a gate.
- NOTED (2026-09-19): research R3 and R7 cited "clarification session 2" questions that do not
  exist in this spec, and R2/R4/R5 cited review findings not present in the feature directory.
  Those citations were fabricated and have been replaced with the actual reasoning.
- Validation pass 1: initial draft named NestJS, Kafka, Postgres, and HTTP verbs in
  requirements. Rewritten to "external treasury stream", "quarantine destination",
  "containerized database and message broker" so the spec stays technology-agnostic.
  Stack choice is governed by the constitution and belongs in `/speckit-plan`.
- Validation pass 2: all items pass. No open clarifications.
- Scope explicitly excludes: program CRUD, funding-decision logic, FX revaluation of
  existing reservations, tranche/term capacity structures.
