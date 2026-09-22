# Phase 0 Research: Configurable Log Level

**Feature**: 005-configurable-log-level | **Date**: 2026-09-22

All Technical Context unknowns are resolved here. No `NEEDS CLARIFICATION` remains.

## R-001 — Why `--silent` cannot fix this

**Finding**: Jest's `--silent`, and its console interception generally, only touch `console.*`.
`nestjs-pino` hands pino a destination that writes to the `process.stdout` file descriptor
directly. Its records therefore bypass Jest entirely and interleave raw with `PASS`/`FAIL`
lines, pushing the result summary above tens of thousands of lines of output.

**Consequence**: the fix must reduce what pino *emits*, not what Jest *captures*. Every
alternative that filters downstream (piping, grepping, a reporter) leaves the volume and the
cost of producing it in place — which `spec.md` already rules out of scope.

## R-002 — Where the verbosity is fixed today

**Decision**: set pino's `level` in `LoggerModule` in `src/app.module.ts`.

**Rationale**: `LoggerModule.forRoot({ pinoHttp: { … } })` at `src/app.module.ts:34-63`
declares `genReqId`, `customProps`, `redact` and `formatters` — but **no `level`**. pino's
own default of `info` therefore applies, and `pinoHttp` writes one record per HTTP request at
`info`. That single missing key is the whole root cause.

`src/main.ts:9-10` creates the app with `bufferLogs: true` and then
`app.useLogger(app.get(Logger))`, so every Nest log also flows through the same pino instance.
One `level` governs the entire process, which is exactly the scope `spec.md` asks for
(one threshold per process, fixed at startup).

**Alternatives considered**:
- *A pino transport that filters* — adds a worker thread and a dependency to achieve what a
  single level already does.
- *Per-module Nest logger overrides* — per-component verbosity, explicitly out of scope.

## R-003 — The value vocabulary

**Decision**: pino's own level names, exactly: `trace`, `debug`, `info`, `warn`, `error`,
`fatal`, `silent`.

**Rationale**: `spec.md` assumes "the set of recognised values is the one the service's
existing logging already understands". These are the strings pino accepts for `level`, so the
configured value passes through untranslated. `silent` is a real pino level that suppresses
everything, which satisfies the spec's "suppress everything, including errors" edge case
without special-casing.

**Alternatives considered**: a project-specific vocabulary mapped onto pino's — a mapping
layer, a second place to drift, and no benefit.

## R-004 — How a test run gets the quiet default without changing deployed behaviour

**Decision**: make the joi default environment-dependent:
`default(process.env.NODE_ENV === 'test' ? 'warn' : 'info')`.

**Rationale**: this reconciles FR-003 (absent ⇒ today's verbosity, no deployed change) with
FR-005 (a test run is quiet by default) in one expression, and it is a pattern the schema
**already uses** — `API_DOCS_ENABLED` at `src/config/env.schema.ts:6-8` computes its default
from `process.env.NODE_ENV` in precisely this way. Jest sets `NODE_ENV=test` when it is
otherwise unset, so both `jest.config.ts` and `jest.e2e.config.ts` runs pick it up with no
new setup file and no change to either config.

Because it is a joi *default*, an explicitly supplied `LOG_LEVEL` always wins — which is what
makes FR-006 (`LOG_LEVEL=info npm test` restores full records) work with no file edit.

**Alternatives considered**:
- *A `setupFiles` entry in `jest.config.ts` that sets `process.env.LOG_LEVEL`* — needs the same
  edit in `jest.config.ts`, `jest.e2e.config.ts`, `jest.recovery.config.ts` and
  `jest.perf.config.ts`, i.e. four places that can drift, versus one.
- *A hardcoded `NODE_ENV === 'test'` ternary in `app.module.ts`* — hides the decision from the
  schema, makes it unconfigurable, and fails FR-001.

## R-005 — Why `warn`, not `silent`, for the test default

**Finding**: `pino-http`'s default `customLogLevel` maps a response with status ≥ 500, or a
request that errored, to `error`, and status 400–499 to `warn`. Routine 2xx traffic is `info`.

**Decision**: the test default is `warn`.

**Consequence**: the ~20,000 `info` records from `test/integration/read-your-writes.spec.ts`
(10,000 trials × 2 requests) and the ~1,000 from `test/integration/concurrency.spec.ts`
disappear, while a genuine service-side error still prints — satisfying FR-005 and the spec's
"suppress routine records but not problems" assumption. `silent` would also clear the console
but would hide the very error a failing test is trying to explain.

**Second log source**: `src/treasury/kafka.config.ts` sets no `logLevel`, so kafkajs runs at its
own default `INFO` and writes `{"level":"INFO",…,"logger":"kafkajs"}` lines that `LOG_LEVEL` does
not govern. The volume is small, so SC-002 was never at risk, but one connection or teardown line
landing between the last test and the summary defeats SC-001's "readable in the last 25 lines".
It is therefore in scope: kafkajs drops to `ERROR` under `NODE_ENV=test`, in `buildKafkaConfig`
and at the two test-only call sites that construct raw clients.

**Known residue**: suites that deliberately provoke refusals (`test/e2e/refusals.spec.ts`,
`capacity-boundary.spec.ts`, `contention.spec.ts`) still emit a `warn` record per 4xx. That is
on the order of tens of lines, not tens of thousands, and it is wanted output: those records
describe the refusal under test. It is recorded as a trade-off rather than engineered away.

## R-006 — The empty-value case

**Decision**: declare the key with `.empty('')`.

**Rationale**: a bare `Joi.string()` rejects the empty string. An operator who writes
`export LOG_LEVEL=` in a shell, or leaves `LOG_LEVEL=` in a `.env` file, yields the empty
string, which would otherwise fail `.valid(...)` and refuse the boot. `.empty('')` treats the
empty string as absent, so the default applies — which is the behaviour `spec.md`'s edge case
requires ("an operator who exports the variable with no value has expressed no preference").

**Correction to an earlier draft**: the chain order does *not* matter. Verified against the
installed joi 18.2.9 — `.empty('').default('info')` and `.default('info').empty('')` both yield
`info` for `''`. Earlier wording claimed `.empty('')` MUST precede `.default(...)`; that was
wrong, and an executor could have wasted time defending an ordering that carries no meaning.

## R-007 — The `.env.example` ↔ `env.schema.ts` parity gate

**Finding**: `scripts/verify-uat.sh` section 6 (lines 115-132) asserts the two files declare
exactly the same key set and fails UAT on any drift.

**Decision**: `LOG_LEVEL` lands in `src/config/env.schema.ts` and `.env.example` in the same
commit. There is no staging order in which the gate is green with only one of them.

## R-008 — Redaction is independent of level

**Finding**: `redact` is a pino serialiser-stage concern applied to whatever record is emitted;
`level` decides only *whether* a record is emitted. Lowering the level cannot expose a
redacted field, and raising it cannot bypass redaction.

**Decision**: the `redact` block in `src/app.module.ts` is left byte-for-byte unchanged, and a
test asserts it is not conditional on the level. This is what FR-008 asks for, and Constitution
V's "secrets MUST come from environment" posture depends on redaction never becoming
level-dependent.

## R-009 — Constitution VII compatibility

**Finding**: Principle VII requires structured JSON logs with a propagated correlation id,
health endpoints and metrics.

**Decision**: nothing in this feature touches `genReqId`, `customProps` or `formatters`. The
records that are still emitted are byte-for-byte what they are today, correlation id included.
Only the emission threshold changes, and only in a test process by default. The trade-off —
that a `test`-profile process is quieter than a deployed one — is recorded in
`docs/ASSUMPTIONS.md` as Principle VII requires.
