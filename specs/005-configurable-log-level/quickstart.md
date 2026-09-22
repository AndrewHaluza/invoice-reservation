# Quickstart: Validating Configurable Log Level

**Feature**: 005-configurable-log-level | **Date**: 2026-09-22

Runnable checks that prove the feature works end to end. Value vocabulary and defaults are in
[`contracts/log-level.env.md`](./contracts/log-level.env.md); the level→record mapping is in
[`data-model.md`](./data-model.md).

## The routine-record detector

Every scenario below that counts log records uses one definition, so that "routine per-request
record" means the same thing everywhere:

```bash
# routine records — MUST be 0 after the change
grep -cE '"level":"info".*"req"' <logfile>

# refusal records — expected to be NON-ZERO, and wanted
grep -cE '"level":"warn".*"req"' <logfile>
```

Counting `"req"` unqualified is wrong. The `warn` default deliberately keeps 4xx records, and
those carry a `req` object too. Six suites inside `npm test` provoke a 4xx by design —
`test/integration/{currency-mismatch,release-nets-to-zero,reserve-endpoint,cancellation}.spec.ts`
and `test/contract/{reservations,releases}.contract.spec.ts` — so an unqualified count is
non-zero even when the feature is working perfectly.

## Prerequisites

- Node 22.x, dependencies installed (`npm ci`).
- A Docker daemon. `npm test` itself needs one: `test/integration` and `test/contract` are
  testcontainers-backed.
- Any scenario that starts the service (S-004, S-005, S-006) runs it **through**
  `./scripts/dev-stack.sh`, not as a separate `npm run start`. A clean worktree has **no `.env`**,
  six keys are `.required()`, and the script exports them into its own process only — so a
  separate `npm run start` fails on `"DATABASE_URL" is required`, which says nothing about
  `LOG_LEVEL`. The script never sets `LOG_LEVEL`, so `LOG_LEVEL=<value> ./scripts/dev-stack.sh`
  works and an unset variable is genuinely the absent-key path.
- Per-worktree ports already exported — `./scripts/dev-stack.sh env` prints the resolved set.
  Never assume 5432/6379/9092.

## S-001 — The reported defect is gone (US1, SC-001, SC-002)

```bash
npm test 2>&1 | tee /tmp/run.log
tail -25 /tmp/run.log
grep -cE '"level":"info".*"req"' /tmp/run.log
grep -cE '"level":"warn".*"req"' /tmp/run.log
```

Expected:
- `tail -25` shows the Jest result summary — suites, tests, time — with no log records above it.
- The routine count is **0**, down from more than twenty thousand.
- The refusal count is non-zero. That is correct and MUST NOT be suppressed by dropping to
  `silent` — those records describe the refusals under test (FR-005).
- No `"logger":"kafkajs"` line appears in the last 25. kafkajs is a second log source that
  `LOG_LEVEL` does not govern; it is quietened separately under `NODE_ENV=test`.
- The suite's own verdict is unchanged: **531 passed, 0 failed, 74 suites** (the merged
  `9b2daa9` baseline).

## S-002 — Failure records survive (US1/AC2, FR-005)

```bash
npm run test:e2e 2>&1 | grep '"level":"warn"' | head
```

Expected: refusal scenarios still print their `warn` record. A run that provokes a 5xx prints an
`error` record. Only routine 2xx `info` records are gone — confirm with the routine detector
reporting 0 over the same output.

## S-003 — An engineer restores full records for one run (US1, FR-006, SC-007)

```bash
LOG_LEVEL=info npx jest test/integration/read-your-writes.spec.ts 2>&1 | grep -cE '"level":"info".*"req"'
```

Expected: a non-zero count — today's behaviour, back, from one variable on the command line and
no file edit.

## S-004 — Deployed behaviour is unchanged (US2/AC2, SC-004)

```bash
env | grep -c '^LOG_LEVEL='   # must report 0 — check the real environment, not
                              # `dev-stack.sh env`, whose fixed list never contains it
./scripts/dev-stack.sh
```

Expected: the service emits the same records, at the same severities,
as before the change — one `info` record per request, correlation id present, JSON shape
identical.

## S-005 — An unrecognised value refuses the boot (US2/AC3, SC-005)

```bash
LOG_LEVEL=verbose ./scripts/dev-stack.sh
```

Expected: startup fails before the server listens with
`Config validation error: "LOG_LEVEL" must be one of [trace, debug, info, warn, error, fatal, silent]`.
It must **not** fall back to a default, and it must **not** fail on `"DATABASE_URL" is required`
— that would mean the run bypassed the script's exported environment.

## S-006 — An empty value takes the default (edge case)

```bash
LOG_LEVEL= ./scripts/dev-stack.sh
```

Expected: starts normally at `info`. No validation error.

## S-007 — Redaction holds at every level (FR-008)

```bash
LOG_LEVEL=trace ./scripts/dev-stack.sh
# then the authenticated request from S-004
```

Expected: the emitted record shows `"authorization":"[redacted]"`, not the bearer token. This is
the running-service half of FR-008; the configuration half — `redact` deep-equal between `trace`
and `error` — is covered by the unit spec's T003 case (h), still covering `authorization`, `cookie` and
`x-api-key` with censor `[redacted]`, and that no level branch touches the `redact` block.

## S-008 — The parity gate passes (US3, SC-006)

```bash
./scripts/verify-uat.sh
npm run docs:verify
```

Expected: `verify-uat.sh` section 6 reports the template and schema key sets identical, with
`LOG_LEVEL` present in both. `docs:verify` reports PASS on all five sections.

## S-009 — Nothing else moved (FR-009, SC-003)

```bash
npm run typecheck && npm run lint && npm run build && npm run test:cov
```

Expected: all green; coverage stays above the 80% global floor (baseline 95.72% statements).
The set of passing and failing tests is identical to the pre-change run captured in S-001.
