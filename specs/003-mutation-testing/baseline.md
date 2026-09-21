# Measured Baseline: Mutation Testing

**Feature**: 003-mutation-testing | **Measured**: 2026-09-21

This file is the single authoritative record of the FR-008 baseline. Every threshold, every
documentation figure and every assumption entry in this feature derives from the numbers
below. They were produced by one real run, not estimated. Nothing in this feature predicted
them, and nothing should.

## The run

- Command: `npm run test:mutation`
- Stryker: 10.0.0
- Configuration: `stryker.config.mjs` with **no `thresholds` block**
- Scope: 32 files / 3400 lines across the six FR-001 directories
- Tests executed: 34 of the 35 unit suites. `test/unit/no-auto-expiry.spec.ts` is excluded
  from the mutation run only (research R-010); it still runs in `npm run test:unit`,
  `npm test` and `npm run test:cov`.
- Wall-clock time: 3m 27s
- Machine: local workstation

## Result

| Metric | Value |
|---|---|
| Mutation score | 37.7% |
| Killed (detected) | 308 |
| Survived (undetected) | 94 |
| Timeout (timed out) | 9 |
| NoCoverage (never executed) | 429 |
| CompileError | 690 |
| Ignored | 0 |
| Total variants | 1530 |

**Limitation.** `test/unit/no-auto-expiry.spec.ts` is excluded from the mutation run
(research R-010). That spec also holds behavioural assertions over `releasePolicy`,
`cancelPolicy` and `scaleRate`, so this score understates what the suite actually detects,
and the floor derived from it is correspondingly slack. It is not the suite's true
effectiveness.

## Derived floor

Arithmetic per contract C-2.5, applied to the score above:

- `break` = largest multiple of 5 not exceeding 37.7 = **35**
- `low`  = break + 5  = **40**
- `high` = break + 10 = **45**

If `break + 10` exceeds 100, `high` is 100 and `low` is 95.

Only `break` governs exit status (FR-010, contract C-2.4).
