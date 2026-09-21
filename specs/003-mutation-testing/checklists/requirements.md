# Specification Quality Checklist: Mutation Testing for Business-Logic Test Effectiveness

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

**Two iterations were run.**

Iteration 1 found four failures:

1. *No implementation details* — FR-001/FR-002 name concrete source paths, and the
   Assumptions section names StrykerJS and GitHub Actions. **Resolved as a deliberate,
   recorded deviation**: the requester named the tool outright and instructed "do not
   evaluate alternatives", and the defended scope IS the requirement — a path list stated
   any less precisely would fail the "testable and unambiguous" item. The tool and
   platform names are confined to the Assumptions section; no FR, SC, acceptance
   scenario, or entity mentions a product name. Every requirement is phrased in terms of
   observable behaviour ("exits non-zero", "browsable report", "does not trigger"), so a
   different tool satisfying them would still pass.
2. *Success criteria are technology-agnostic* — the first draft of SC-003 said "no Docker
   daemon". Rewritten as "no container runtime".
3. *Requirements are testable* — the first draft said the run "should be fast". Replaced
   by the numeric FR-012 budget plus FR-013's explicit failure path when it cannot be met.
4. *Edge cases identified* — the first draft had three. Expanded to eight, covering the
   uncovered file, the infinite loop, the already-red suite, the equivalent change, the
   blown budget, the renamed file, run-to-run determinism, and the missing container
   runtime.

Iteration 2 passed all sixteen items.

**No [NEEDS CLARIFICATION] markers were needed.** The request was unusually complete: tool,
scope, runner, threshold procedure, time budget, trigger conditions, and acceptance
criteria were all supplied. The one genuinely unknown quantity — the baseline score — is
correctly left unstated and is produced by executing FR-008 rather than by asking.

**Deliberate non-goal recorded**: this feature does not raise the score. Writing tests to
kill surviving mutants is separate work, gated by the floor this feature installs.
