# Implementation Plan: Configurable Log Level

**Branch**: `005-configurable-log-level` | **Date**: 2026-09-22 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-configurable-log-level/spec.md`

## Summary

`LoggerModule.forRoot` in `src/app.module.ts` never sets pino's `level`, so pino's default of
`info` applies and `pinoHttp` writes one record per HTTP request. A full suite emits more than
twenty thousand of them, straight to the `process.stdout` file descriptor where Jest's
`--silent` cannot reach, burying the result summary.

The fix is one new environment setting, `LOG_LEVEL`, validated by joi against pino's own level
names and handed to `LoggerModule` through `forRootAsync`. Its default is computed from
`NODE_ENV` — `warn` under `test`, `info` everywhere else — the same pattern
`API_DOCS_ENABLED` already uses in the schema. A test run therefore goes quiet with no setup
file and no change to any Jest config, while a deployed service that sets nothing behaves
exactly as it does today. An explicit value always wins, so `LOG_LEVEL=info npm test` restores
full records for one run.

## Technical Context

**Language/Version**: TypeScript 5.x (strict), Node 22.x

**Primary Dependencies**: NestJS 11, `nestjs-pino` + pino, joi (`src/config/env.schema.ts`),
`@nestjs/config`. **No new dependency** — pino already accepts `level`.

**Storage**: N/A. No entity, no table, no migration.

**Testing**: Jest (`jest.config.ts`); e2e via `jest.e2e.config.ts`. New coverage is a
Docker-free unit spec.

**Target Platform**: Linux/macOS server process

**Project Type**: Single NestJS web service

**Performance Goals**: A full `npm test` run emits zero routine per-request records, down from
>20,000. Suite wall time must not regress beyond the ~196s baseline; dropping ~28MB of stdout
writes should improve it.

**Constraints**: `.env.example` and `src/config/env.schema.ts` must declare identical key sets
(`scripts/verify-uat.sh` §6, lines 115-132) — both change in one commit. Redaction stays
unconditional. No test outcome may change. There is no `.env` in a clean worktree and
`scripts/dev-stack.sh` does not create one — it exports into its own process, so any manual
service run goes through the script rather than a bare `npm run start`.

**Scale/Scope**: 4 source/config files touched (`app.module.ts`, `env.schema.ts`, `kafka.config.ts`, `.env.example`), 1 new source file, 1 new unit spec, 3 test-support call sites, 2 docs files. No runtime data
path touched.

## Constitution Check

*GATE: passed before Phase 0, re-evaluated after Phase 1 — see below.*

| Principle | Bearing | Verdict |
|---|---|---|
| I — Money never float | Not touched. No arithmetic, no amount. | PASS |
| II — Capacity is a ledger | Not touched. No position written or read. | PASS |
| III — Concurrency safety | Not touched. No lock, transaction or query changed. | PASS |
| IV — Idempotency and ordering | Not touched. No inbound handler changed. | PASS |
| V — Secure by default (NON-NEGOTIABLE) | **Directly engaged.** `redact` must stay in force at every level. Plan leaves the `redact` block byte-for-byte unchanged and adds a unit spec asserting it is not conditional on the level (FR-008). `LOG_LEVEL` is a plain operational setting, not a secret; it enters through the environment like every other key. | PASS |
| VI — Test-first (NON-NEGOTIABLE) | A red unit spec for the schema entry and the logger factory is written before the change, per the task ordering below. Coverage floor 80% unaffected. | PASS |
| VII — Runnable locally, observable in production | **Directly engaged.** Structured JSON, correlation id, health and metrics all unchanged: `genReqId`, `customProps` and `formatters` are not touched. The one trade-off — a `test`-profile process is quieter than a deployed one — is recorded in `docs/ASSUMPTIONS.md` as this principle requires. `.env.example` gains the key, keeping a clean clone runnable. | PASS |

**Technology constraints**: no `any`, no non-null assertion, no new dependency, file sizes
unaffected, domain layer untouched (`app.module.ts` is composition root, `env.schema.ts` is
config).

**Post-Phase-1 re-evaluation**: unchanged — the design adds one validated string and one
`forRoot` → `forRootAsync` conversion. No gate moved, no entry in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/005-configurable-log-level/
├── spec.md              # /speckit-specify output
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── log-level.env.md # Phase 1 output — the env-var contract
├── checklists/
│   └── requirements.md  # 16/16 passing
└── tasks.md             # /speckit-tasks output — NOT created here
```

### Source Code (repository root)

```text
src/
├── app.module.ts             # MODIFIED — LoggerModule.forRoot → forRootAsync, level from config
└── config/
    ├── env.schema.ts         # MODIFIED — add the LOG_LEVEL joi key
    ├── logger.config.ts      # NEW — exported buildPinoHttpOptions(level): Options, holds the
    │                         #       four existing pinoHttp blocks so they are unit-testable
    └── ../treasury/kafka.config.ts  # MODIFIED — kafkajs drops to ERROR under NODE_ENV=test;
                              #       a second log source LOG_LEVEL does not govern

.env.example                  # MODIFIED — declare LOG_LEVEL (parity gate)

test/
└── unit/
    └── logger-config.spec.ts # NEW — level resolution, value set, redaction invariance

README.md                     # MODIFIED — document the setting (FR-010)
docs/ASSUMPTIONS.md           # MODIFIED — record the quiet-test-default trade-off (Principle VII)
```

**Structure Decision**: the existing single-service layout. This feature adds no module,
directory or layer; it edits the composition root, the config schema and the environment
template, which is where every other setting in this project already lives.

## Phase 0 — Research

Complete. See [`research.md`](./research.md). Nine findings, all `NEEDS CLARIFICATION`
resolved:

- **R-001** `--silent` cannot help — pino writes to the stdout fd, not `console.*`.
- **R-002** root cause is the missing `level` at `src/app.module.ts:34-63`.
- **R-003** value vocabulary is pino's own: `trace|debug|info|warn|error|fatal|silent`.
- **R-004** the default is `NODE_ENV`-dependent, mirroring `API_DOCS_ENABLED`; no Jest setup
  file, no change to any of the four Jest configs.
- **R-005** `warn` rather than `silent`, so a genuine service-side error still prints; residual
  `warn` records from deliberate-refusal suites are wanted output and are recorded as such.
- **R-006** `.empty('')` so `LOG_LEVEL=` takes the default instead of refusing the boot; chain
  order relative to `.default()` is irrelevant, contrary to an earlier draft.
- **R-007** schema and template change together or the UAT gate goes red.
- **R-008** redaction is a serialiser concern, independent of level, and stays unchanged.
- **R-009** Constitution VII's JSON/correlation-id guarantees are untouched.
- **R-010** kafkajs is a second, ungoverned log source; in scope for SC-001, out of scope for
  `LOG_LEVEL` itself.

## Phase 1 — Design & Contracts

Complete.

- [`data-model.md`](./data-model.md) — the one entity, its ordered value set, the
  level→record mapping, and the explicit absence of any persisted state or transition.
- [`contracts/log-level.env.md`](./contracts/log-level.env.md) — the environment-variable
  contract: exact joi entry, exact template entry, the behaviour table, the consumption shape,
  and its backward compatibility.
- [`quickstart.md`](./quickstart.md) — nine runnable validation scenarios S-001…S-009, one per
  success criterion, including the pre/post `grep -c '"req"'` count that proves SC-002 and the
  `verify-uat.sh` run that proves SC-006.

### Design decisions carried into implementation

1. **`forRoot` → `forRootAsync` with `ConfigService` injected.** Reading `process.env` directly
   in `app.module.ts` would bypass joi and defeat FR-002.
2. **`.empty('')` precedes `.default(...)`.** Order matters; joi defaults only fill `undefined`.
3. **The `redact`, `genReqId`, `customProps` and `formatters` blocks move verbatim** into
   `src/config/logger.config.ts`, behind an exported `buildPinoHttpOptions(level)`. The
   extraction exists so the level-propagation and redaction-invariance assertions are unit
   tests rather than module bootstraps; it changes no behaviour. The factory **must** carry a
   `: Options` return annotation (`pino-http`): today those arrow functions are contextually
   typed by `LoggerModule.forRoot`'s parameter, and in a standalone literal `strict` +
   `noImplicitAny` yields three `TS7006` errors without it. Any rewording of the four
   blocks is out of scope and would risk FR-008/FR-009.
4. **No Jest config changes.** Jest sets `NODE_ENV=test` itself; all four configs inherit the
   quiet default for free.

### Implementation order (for `/speckit-tasks`)

1. **[RED]** `test/unit/logger-config.spec.ts` — asserts the schema accepts each of the seven
   levels, rejects `verbose`, maps `''` to the default, defaults to `warn` under
   `NODE_ENV=test` and `info` otherwise; and that `buildPinoHttpOptions(level).level` echoes
   each level, that nothing below the threshold is emitted at `error`, and that `redact.paths`
   is identical at `trace` and at `error`. Fails against current `main`.
2. **[GREEN]** Extract the four pinoHttp blocks into `src/config/logger.config.ts` as
   `buildPinoHttpOptions(level)`.
3. **[GREEN]** Add the `LOG_LEVEL` key to `src/config/env.schema.ts`.
4. **[GREEN]** Convert `LoggerModule` to `forRootAsync` in `src/app.module.ts`, passing
   `buildPinoHttpOptions(config.getOrThrow<string>('LOG_LEVEL'))`.
5. Declare `LOG_LEVEL` in `.env.example` — same commit as step 3, per R-007.
6. Document it in `README.md` (FR-010) and record the trade-off in `docs/ASSUMPTIONS.md`
   (Principle VII).
7. Drop kafkajs to `ERROR` under `NODE_ENV=test` in `src/treasury/kafka.config.ts` and at the
   three test-only raw-client call sites (`stream-lag.spec.ts` ×2, `redpanda-container.ts`,
   plus `test/performance/sc-002a-treasury-visibility.spec.ts` for consistency). It is a second log source `LOG_LEVEL` does not govern,
   and one teardown line between the last test and the summary defeats SC-001.
8. Run `quickstart.md` S-001…S-009 end to end.

## Complexity Tracking

No Constitution Check violations. Section intentionally empty.
