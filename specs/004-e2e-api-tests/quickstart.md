# Quickstart: Validating the End-to-End Suite

**Feature**: 004-e2e-api-tests | **Date**: 2026-09-21

Seven scenarios that together prove the feature works. Run them in order — scenario 6 is
the one that must not be skipped.

**Prerequisites**: Node 22.x, `npm ci` completed, and **a running container runtime**.
Unlike feature 003, this suite genuinely needs one.

---

## Scenario 1 — The suite runs

```bash
npm run test:e2e
echo $?
```

**Expected**:
- `0`.
- Three spec files run: refusals, capacity boundary, contention.
- No log line mentions Redpanda, a Kafka broker or a topic. If one does, contract C-5.2 is
  broken — the treasury path is being exercised through a broker rather than the handler.

Covers: FR-001, FR-008, C-1, C-2, C-3.

---

## Scenario 2 — The four uncovered refusals now appear over HTTP

```bash
npm run test:e2e -- -t 'refus'
```

**Expected**: assertions on the response `code` for `PROGRAM_OVER_LIMIT`,
`DUPLICATE_INVOICE`, `REQUEST_IN_FLIGHT` and `IDEMPOTENCY_EXPIRED`, each with the status the
error contract assigns it, each followed by a read of the program row showing nothing was
written.

**Check**: grep the suite for each code and confirm the hit is on a **response body**, not
on a service return value.

```bash
grep -rn 'PROGRAM_OVER_LIMIT\|DUPLICATE_INVOICE\|REQUEST_IN_FLIGHT\|IDEMPOTENCY_EXPIRED' test/e2e/
```

Covers: FR-002, US1, SC-001.

---

## Scenario 3 — The boundary is exact

```bash
npm run test:e2e -- -t 'boundary'
```

**Expected**: three deterministic requests — exactly `available` accepted, `available + 1`
refused with `INSUFFICIENT_CAPACITY`, and a reservation succeeding after a release returns
capacity. The refusal's `details.requestedMinor` and `details.availableMinor` are asserted,
not just the code.

**Expected wall time**: under 30 seconds excluding container start-up (SC-002).

Covers: FR-003, US2, SC-002.

---

## Scenario 4 — Contention never surfaces as a failure

```bash
npm run test:e2e -- -t 'contention'
```

**Expected**: every simultaneous write accepted, no `500`, no response mentioning a
serialization or deadlock failure, and a final position equal to the sum of the accepted
writes.

> If this scenario produces a body-less `501` or `404`, the application was started with
> `init()` rather than `listen(0)`. That is a defect in the harness, not evidence of a
> concurrency bug — see R-004.

Covers: FR-004, FR-005, US3, SC-003.

---

## Scenario 5 — Nothing else moved

The whole of FR-011, checked rather than assumed.

```bash
npm test
npm run test:unit
npm run test:cov
npm run typecheck
npm run lint
npm run build
npm run docs:verify
git diff --stat jest.mutation.config.js stryker.config.mjs \
  jest.recovery.config.ts jest.perf.config.ts package-lock.json
```

**Expected**:
- Every command passes.
- `npm test` reports the **same suite and test counts** as before the feature. If the
  numbers grew, the `testPathIgnorePatterns` entry is missing and `test/e2e/` has joined
  the default run.
- `npm run test:cov` reports the **same coverage percentages** as before.
- The final `git diff --stat` prints nothing.

Covers: FR-009, FR-010, FR-011, SC-005, C-4.

---

## Scenario 6 — Prove the new assertions can fail

The one scenario that must not be skipped. An assertion never observed failing proves
nothing.

```bash
git status --porcelain            # expect clean
# in a scratch copy only — never on the working branch:
#   in src/capacity/domain/policies/reserve.policy.ts, change
#     reservedMinor > availableMinor
#   to
#     reservedMinor >= availableMinor
npm run test:e2e
echo $?
```

**Expected**: non-zero, and the failure names the boundary scenario — the request for
exactly the available amount is now refused.

**Then**: discard the scratch copy entirely. `git status --porcelain` must return to clean.

> The mutated source is **never committed**. FR-010 forbids changing production behaviour,
> and this is a throwaway probe, not a change. It is the same discipline feature 003 applied
> to its own gate, and the reason Principle VI is satisfied by a test-only feature.

Covers: SC-008, Constitution Principle VI.

---

## Scenario 7 — The automation runs it and disturbs nothing

1. Open a pull request → the `gate` job runs the new step.
2. Confirm the existing steps — lint, typecheck, test, coverage, build — report exactly as
   before, in the same order.
3. Force an e2e failure → the job fails, and the earlier steps still report their own
   results.
4. Confirm `git diff` on `.github/workflows/release-gates.yml` is **empty**.

**Expected**: all four hold.

Covers: FR-014, SC-005.

---

## Repository hygiene check

After every scenario:

```bash
git status --porcelain
```

**Expected**: clean. This feature generates no report, no incremental state and no
artefact. Anything appearing here is a leak.

Covers: FR-010, SC-005.
