# Specification Quality Checklist: End-to-End API Tests for Overbooking, Idempotency, Lock Contention and Access Control

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-21
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

**16/16 passing.**

Four points a reviewer should read before planning, because they bound the feature more
than any single requirement does:

1. **The scope was cut deliberately, and the cut is the main decision here.** The request
   named four concerns; an audit of the existing suite found two of them — idempotency and
   access control — already covered end to end against the assembled application. The spec
   records that coverage in a table and removes both from scope. FR-012 forbids
   re-asserting them. If a reviewer disagrees with the audit, that is the thing to
   challenge first; every other requirement follows from it.

2. **One named concern is unreachable, and the spec says so rather than faking it.**
   A genuine multi-program deadlock needs two transactions taking two programs in opposite
   orders. One program is locked per transaction and no endpoint accepts more than one, so
   no supported request can express it. FR-013 forbids simulating it below the API and
   presenting the result as end-to-end evidence. What is specified instead is the
   contention guarantee the project already states, asserted for the first time above the
   repository. The Assumptions section records the debt that falls due if a multi-program
   endpoint is ever added.

3. **The gaps carry the feature, and there are more than the first draft claimed.** Each
   of the fourteen refusal codes was grepped across `test/contract` and `test/integration`
   and every hit read to see whether it asserts a response body or a service return value.
   Nine are observed over HTTP. Five are not: over-limit, duplicate invoice, request in
   flight, idempotency expired, and invalid amount. The last is unreachable — the request
   DTO admits only strictly positive integer strings, so validation refuses before the
   domain guard runs — leaving four reachable gaps. An earlier draft of this checklist said
   one; that was reached by looking for the over-limit case rather than walking the
   enumeration, and User Story 1 was widened to four before planning continued. Research
   R-009 carries the full table.

4. **The capacity boundary is the second gap.** It is proven today only inside the
   thousand-request storm, which reserves 1,000 against a 100,000 limit — no request in it
   ever lands on the edge, so a `>` to `>=` mutation survives it untouched. Three
   deterministic requests kill it in seconds.

The Context section names existing test files by path. That is deliberate: it is evidence
for the scope cut, not a statement of how this feature will be built. No functional
requirement, success criterion or acceptance scenario names a file, framework or library.

SC-008 requires the gate to be seen failing once, on a throwaway copy, before it is
trusted — the same discipline the constitution's test-first principle demands and that
feature 003 applied to its own gate.
