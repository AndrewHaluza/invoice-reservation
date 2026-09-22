---

description: "Task list for 005-configurable-log-level"
---

# Tasks: Configurable Log Level

**Input**: Design documents from `/specs/005-configurable-log-level/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/log-level.env.md](./contracts/log-level.env.md), [quickstart.md](./quickstart.md)

**Tests**: Test tasks ARE included. Constitution VI (Test-First, NON-NEGOTIABLE) makes them mandatory for this repository, and `plan.md` fixes the RED step as T003.

**Organization**: Grouped by user story. The three stories share one plumbing change, so that change lives in Phase 2 and each story phase verifies its own outcome against it.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1, US2, US3 — maps to the user stories in `spec.md`
- Exact file paths in every description

## Path Conventions

Single NestJS service at repository root: `src/`, `test/`, `docs/`, `scripts/`. Paths below are repo-relative, matching the Source Code tree in `plan.md`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Capture the before-state that SC-002 and SC-003 are measured against, and get onto a branch. No production code changes.

**Prerequisite for T001**: a running Docker daemon. `npm test` includes `test/integration` and `test/contract`, both testcontainers-backed, and will fail without one.

- [ ] T001 Capture the baseline into `/tmp/005-before.log` (the raw run) and `/tmp/005-baseline.txt` (the extracted counts). Not "the PR description" — no PR exists yet, and T011 reads these back:

  ```bash
  npm test 2>&1 | tee /tmp/005-before.log
  {
    echo "routine=$(grep -cE '"level":"info".*"req"' /tmp/005-before.log)"
    echo "refusal=$(grep -cE '"level":"warn".*"req"' /tmp/005-before.log)"
    echo "verdict=$(grep -E '^Tests:' /tmp/005-before.log | tail -1)"
    echo "suites=$(grep -E '^Test Suites:' /tmp/005-before.log | tail -1)"
  } > /tmp/005-baseline.txt
  cat /tmp/005-baseline.txt
  ```

  Expect `routine` in the tens of thousands. Record whatever `verdict` and `suites` actually say — do not assume a number; T010 compares against this file, not against a literal.

- [ ] T002 Get onto a feature branch. The spec artifacts under `specs/005-configurable-log-level/` are currently untracked, so a bare clean-tree check will fail on them:

  ```bash
  git switch -c 005-configurable-log-level
  git add specs/005-configurable-log-level && git commit -m "docs: spec-kit artifacts for configurable log level"
  git status --short -- src test .env.example README.md docs/ASSUMPTIONS.md   # must be empty
  ```

  The clean-tree requirement applies to `src/`, `test/`, `.env.example`, `README.md` and `docs/ASSUMPTIONS.md` only.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The `LOG_LEVEL` setting itself — extraction, schema, template and logger wiring. All three user stories read from this one change.

**⚠️ CRITICAL**: No user story verification can begin until this phase is complete and T003 has gone from RED to GREEN.

**Why the file contents are inlined below**: each of these tasks is stated as the resulting file content, not as intent. Earlier drafts said "move verbatim" and "assert the default", both of which require the executor to derive something it cannot derive — see the notes on contextual typing (T004a) and on joi's `abortEarly` and module-load-time evaluation (T003).

### RED step (Constitution VI)

- [ ] T003 Create `test/unit/logger-config.spec.ts`. Three things about this repository make the obvious spec wrong, so the structure below is mandatory, not a suggestion:

  1. **`envSchema` has six `.required()` keys** (`DATABASE_URL`, `REDIS_URL`, `KAFKA_BROKERS`, `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD`, `JWT_SECRET`). With joi's default `abortEarly: true`, `envSchema.validate({ LOG_LEVEL: 'verbose' })` returns `"DATABASE_URL" is required` and applies **no defaults** — every naive assertion reads `undefined` and fails for the wrong reason. Validate against a complete baseline with `{ abortEarly: false, allowUnknown: true }`, matching `src/config/configuration.module.ts:11`, and assert with `toContain`.
  2. **The `NODE_ENV` ternary in the schema is evaluated once, at module import.** Jest sets `NODE_ENV=test` before the file loads, so the default is baked to `warn` for the whole spec. Setting `process.env.NODE_ENV` inside a test case has no effect. Re-import the module per case via `jest.resetModules()`.
  3. **`pino` is not a direct dependency** (`package.json` has `nestjs-pino` and `pino-http` only; `pino` is hoisted transitively). Do not import it. Assert the level as a string.

  ```ts
  import type { ObjectSchema } from 'joi';

  const VALID_ENV = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    KAFKA_BROKERS: 'localhost:9093',
    KAFKA_SASL_USERNAME: 'u',
    KAFKA_SASL_PASSWORD: 'p',
    JWT_SECRET: 'x'.repeat(32),
  } as const;

  const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;

  const OPTS = { abortEarly: false, allowUnknown: true } as const;

  // Re-imports env.schema.ts under a chosen NODE_ENV, because its default is
  // computed at module load and cannot be varied any other way.
  const schemaUnder = (nodeEnv: string): ObjectSchema => {
    jest.resetModules();
    process.env.NODE_ENV = nodeEnv;
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
    return require('../../src/config/env.schema').envSchema as ObjectSchema;
  };

  describe('LOG_LEVEL', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    afterEach(() => { process.env.NODE_ENV = originalNodeEnv; });
    // (a) each of LEVELS validates
    // (b) 'verbose' is rejected and error.message contains 'LOG_LEVEL' and each accepted value
    // (c) LOG_LEVEL: '' resolves to the default rather than erroring
    // (d) schemaUnder('test'),       LOG_LEVEL absent  => 'warn'
    // (e) schemaUnder('production'), LOG_LEVEL absent  => 'info'
    // (f) schemaUnder('test') with LOG_LEVEL: 'trace'  => 'trace'  (explicit beats default)
  });

  describe('buildPinoHttpOptions', () => {
    // (g) for each of LEVELS: buildPinoHttpOptions(l).level === l   — FR-004, first half
    // (h) buildPinoHttpOptions('error') and buildPinoHttpOptions('trace') have
    //     deep-equal `redact` — paths req.headers.authorization, req.headers.cookie,
    //     req.headers["x-api-key"], censor '[redacted]'                — FR-008
    // (i) genReqId, customProps and formatters are all functions/present
  });
  ```

  The skeleton above lists the cases as comments; write each one out as a real `it()` block, and add the import the second `describe` needs:

  ```ts
  import { buildPinoHttpOptions } from '../../src/config/logger.config';
  ```

  Run `npx jest test/unit/logger-config.spec.ts` and confirm it FAILS **with the right evidence**: `TS2307: Cannot find module '../../src/config/logger.config'`, and, once that module exists, assertion failures on the `LOG_LEVEL` default cases. A failure reading `Your test suite must contain at least one test` means the commented cases were never written out — that is not a RED step, it is an empty file.

  **Not asserted, deliberately**: that pino's numeric level ordering puts `warn` below `error`. That is a constant of the library (30 < 50), can never fail, and would give false assurance for FR-004's second half. The real proof that nothing below the threshold is emitted is T009's measured record count.

### GREEN step

- [ ] T004a Create `src/config/logger.config.ts` with exactly this content, moving the four blocks out of `src/app.module.ts:34-63`:

  ```ts
  import type { IncomingMessage } from 'node:http';
  import type { Options } from 'pino-http';
  import { CORRELATION_HEADER, resolveCorrelationId } from '../shared/correlation';

  type CorrelationRequest = IncomingMessage & { correlationId?: string };

  export const buildPinoHttpOptions = (level: string): Options => ({
    level,
    // Runs whether it is reached before or after CorrelationMiddleware: it
    // reuses an id already on the request, otherwise resolves one from the
    // header (or a fresh UUID) and stashes it for the middleware to reuse.
    genReqId: (req) => {
      const request = req as CorrelationRequest;
      const correlationId =
        request.correlationId ?? resolveCorrelationId(request.headers[CORRELATION_HEADER]);
      request.correlationId = correlationId;
      return correlationId;
    },
    customProps: (req) => ({
      correlationId: (req as CorrelationRequest).correlationId,
    }),
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]'],
      censor: '[redacted]',
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
    // No transport / prettyPrint: production logs are JSON.
  });
  ```

  **The `: Options` return annotation is load-bearing and must not be dropped.** Today those three arrow functions are contextually typed by `LoggerModule.forRoot`'s parameter. In a standalone object literal that context is gone, and `tsconfig.json`'s `strict` + `noImplicitAny` produce three `TS7006: Parameter implicitly has an 'any' type` errors on `req`, `req` and `label`. The annotation restores contextual typing. If `tsc` reports that `Options` needs type arguments, use `Options<IncomingMessage, ServerResponse>` with `ServerResponse` imported as a type from `node:http` — do not fall back to `any`, which the constitution's technology constraints forbid without an inline justification.

  `eslint-plugin-boundaries` permits this import: `eslint.config.mjs` allows `config → shared, config`. Behaviour is unchanged; this is a pure extraction.

- [ ] T004 Add the `LOG_LEVEL` key to `src/config/env.schema.ts`, after `API_DOCS_ENABLED`:

  ```ts
  LOG_LEVEL: Joi.string()
    .valid('trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent')
    .empty('')
    .default(process.env.NODE_ENV === 'test' ? 'warn' : 'info'),
  ```

  `.empty('')` is required — a bare `Joi.string()` rejects `''`, so without it `LOG_LEVEL=` would refuse the boot instead of taking the default. Its position in the chain relative to `.default()` does **not** matter (verified in the installed joi 18.2.9: both orders yield `info` for `''`); keep the order above for consistency with the rest of the file.

- [ ] T005 Declare `LOG_LEVEL` in `.env.example` with the value `info` and the comment block from `contracts/log-level.env.md`. This MUST land in the same commit as T004 — `scripts/verify-uat.sh` section 6 (lines 115-132) asserts the template and schema key sets are identical and fails UAT on drift (research.md R-007). The `#`-prefixed comment lines do not match its `^\s*([A-Z][A-Z0-9_]*)\s*=` regex, so the example recipe inside the comment is safe.

- [ ] T006 In `src/app.module.ts`, replace the whole `LoggerModule.forRoot({ ... })` block at lines 34-63 with:

  ```ts
  LoggerModule.forRootAsync({
    inject: [ConfigService],
    useFactory: (config: ConfigService) => ({
      pinoHttp: buildPinoHttpOptions(config.getOrThrow<string>('LOG_LEVEL')),
    }),
  }),
  ```

  Add `import { buildPinoHttpOptions } from './config/logger.config';`. Delete the now-unused `IncomingMessage` type import, the local `type CorrelationRequest` at line 20, and the `CORRELATION_HEADER` / `resolveCorrelationId` names from the `./shared/correlation` import **only if** nothing else in the file still uses them — `CorrelationMiddleware` from that same import is still used by `configure()`, so the import statement itself stays. Let `npm run lint` decide; it flags unused imports.

  Do not read `process.env` here: that bypasses joi and defeats FR-002. `config.getOrThrow('LOG_LEVEL')` is safe on the absent-key path — `@nestjs/config` writes joi-resolved defaults back into `process.env` before the factory runs.

- [ ] T007 Silence kafkajs under test. `src/treasury/kafka.config.ts` sets no `logLevel`, so kafkajs runs at its default `INFO` and writes its own `{"level":"INFO",...,"logger":"kafkajs"}` lines. These are **not** governed by `LOG_LEVEL` and are invisible to the routine-record detector (uppercase level, no `req` field), but a single connection or teardown line between the last test and the summary breaks T009's "`tail -25` with no log records above it" criterion (SC-001). In `buildKafkaConfig`, add to the returned object:

  ```ts
  logLevel: config.get<string>('NODE_ENV') === 'test' ? logLevel.ERROR : logLevel.INFO,
  ```

  importing `{ logLevel }` from `kafkajs` as a value (not a type). Four test-only call sites construct raw clients and need the same treatment: `test/support/redpanda-container.ts:25` `test/integration/stream-lag.spec.ts:88` and `:160`, and `test/performance/sc-002a-treasury-visibility.spec.ts:178` — pass `logLevel: logLevel.ERROR` directly at each. The performance suite is in `jest.config.ts`'s `testPathIgnorePatterns`, so it cannot affect SC-001; it is included for consistency, because `npm run test:perf` floods identically. The full set is `grep -rn "new Kafka(" src test` — seven sites, three of which go through `buildKafkaConfig` and are covered by the change above. Keeping `ERROR` rather than `NOTHING` preserves a genuine broker failure in the output, consistent with the `warn` choice for pino.

- [ ] T008 Run `npx jest test/unit/logger-config.spec.ts` and confirm it now PASSES, then `npm run typecheck && npm run lint` to confirm the extraction and the `forRootAsync` conversion introduce no `any`, no non-null assertion and no boundary violation.

**Checkpoint**: `LOG_LEVEL` exists, validates, and governs pino; kafkajs is quiet under test. Story verification can begin.

---

## Phase 3: User Story 1 - Read a test run's result without scrolling past the logs (Priority: P1) 🎯 MVP

**Goal**: A full automated test run emits no routine per-request record, its result summary is readable at the end of the output, and its verdict is unchanged.

**Independent Test**: Run the full suite, capture the console output, confirm the result summary is in the last lines, no routine request record appears, and the pass/fail verdict matches T001's baseline.

### Tests for User Story 1

- [ ] T009 [US1] Verification only — **write no new assertion here.** This task confirms T003 cases (g) and (h), which are the sole home of these assertions; nothing later re-runs them: (g) `buildPinoHttpOptions(l).level === l` for each of the seven levels, and (h) deep-equal `redact` between `buildPinoHttpOptions('trace')` and `buildPinoHttpOptions('error')` with paths `req.headers.authorization`, `req.headers.cookie`, `req.headers["x-api-key"]` and censor `[redacted]`. Open `test/unit/logger-config.spec.ts`, confirm both cases exist as real `it()` blocks and pass, and confirm no `redact` value anywhere in `src/config/logger.config.ts` branches on the level. Together these prove FR-008 (redaction never conditional on verbosity) and FR-004's first half (the configured level reaches pino). If (g) or (h) is missing, go back and finish T003 rather than adding a second copy here.

### Implementation for User Story 1

- [ ] T010 [US1] Run quickstart S-001: `npm test 2>&1 | tee /tmp/005-after.log`, then the routine-record detector `grep -cE '"level":"info".*"req"' /tmp/005-after.log` MUST report **0**, and `tail -25 /tmp/005-after.log` MUST show the Jest result summary with no log records above it (SC-001, SC-002, and FR-004's second half — zero `info` records under a `warn` threshold is the measured proof that nothing below the level is emitted). Do **not** count `"req"` unqualified: the `warn` default deliberately keeps 4xx records, which also carry a `req` object. Six in-scope suites provoke a 4xx by design — `test/integration/currency-mismatch.spec.ts`, `release-nets-to-zero.spec.ts`, `reserve-endpoint.spec.ts`, `cancellation.spec.ts`, `test/contract/reservations.contract.spec.ts`, `releases.contract.spec.ts` — so a non-zero `grep -cE '"level":"warn".*"req"' /tmp/005-after.log` is the expected, correct outcome and MUST NOT be suppressed by lowering the level to `silent`. If `tail -25` still shows a `"logger":"kafkajs"` line, T007 was not applied to all four call sites — fix T007, do not touch `LOG_LEVEL`.
- [ ] T011 [US1] Run quickstart S-009's comparison: diff the passing/failing test sets in `/tmp/005-before.log` and `/tmp/005-after.log`. They MUST be identical to the verdict captured by T001:

  ```bash
  diff <(grep -E '^(Tests|Test Suites):' /tmp/005-before.log | tail -2) \
       <(grep -E '^(Tests|Test Suites):' /tmp/005-after.log  | tail -2)
  ```

  Expect no output. `/tmp/005-baseline.txt` holds the same two lines in extracted form if the diff needs explaining (SC-003, FR-009). Compare against the captured run, never against a literal from this document — the baseline moves as `develop` moves. Any difference is a blocker, not something to reconcile by editing a test.
- [ ] T012 [US1] Run quickstart S-002: `npm run test:e2e 2>&1 | grep '"level":"warn"' | head` MUST still show refusal records, proving a genuine service-side problem survives the quiet default (FR-005, US1/AC2). Confirm the routine-record detector `grep -cE '"level":"info".*"req"'` reports 0 over the same output.
- [ ] T013 [US1] Run quickstart S-003: `LOG_LEVEL=info npx jest test/integration/read-your-writes.spec.ts 2>&1 | grep -cE '"level":"info".*"req"'` MUST report a non-zero count, proving one environment variable on the command line restores today's records with no file edit (FR-006, SC-007).

**Checkpoint**: The reported defect is closed and independently verifiable. This alone is a shippable MVP.

---

## Phase 4: User Story 2 - Choose the verbosity of a running service (Priority: P2)

**Goal**: An operator can raise or lower a running service's verbosity through the environment, and an unrecognised value refuses the boot.

**Independent Test**: Start the service with different values of the setting and confirm the volume and kind of records differ, with no change to functional behaviour.

**⚠️ This phase is MANUAL.** T014, T015, T016 and T017 each start a foreground service and are
ended by the operator with Ctrl-C. They cannot complete unattended — an automated runner will hang
on them. Run this phase interactively, or defer it and ship the MVP (Phases 1-3), which is fully
automatable.

**⚠️ How to run the service for this phase.** A clean worktree has **no `.env` file**, and six env
keys are `.required()`. `scripts/dev-stack.sh` does **not** create one — it `export`s
`DATABASE_URL`, `REDIS_URL`, `KAFKA_BROKERS`, `KAFKA_SASL_*`, `JWT_SECRET` and `NODE_ENV` into its
own process (lines 51-83) and those die with the subshell. So `./scripts/dev-stack.sh up` followed
by a separate `npm run start` fails on `"DATABASE_URL" is required`, which says nothing about
`LOG_LEVEL`.

Every check below therefore runs the service **through** the script, which starts the stack and
then `npm run start:dev` inside its own exported environment (the default `run` subcommand,
line 214). `LOG_LEVEL` is inherited from the invoking shell — the script never sets or overwrites
it — so prefixing the variable works:

```bash
LOG_LEVEL=<value> ./scripts/dev-stack.sh
```

Ports are per-worktree; `./scripts/dev-stack.sh env` prints the resolved set. Never hardcode
5432/6379/9092. Stop each run with Ctrl-C — the script's EXIT trap tears the stack down.

- [ ] T014 [US2] Run quickstart S-004: `./scripts/dev-stack.sh` with **no** `LOG_LEVEL` in the
  environment. Confirm with `env | grep -c '^LOG_LEVEL='` reporting 0 *before* launching — do not
  use `./scripts/dev-stack.sh env` for this, which prints a fixed list (lines 89-103) that never
  contains `LOG_LEVEL` and so reports 0 unconditionally, proving nothing. The script exports
  `NODE_ENV=development`, so the expected resolved level is `info`. Issue an authenticated request
  using the recipe documented at `README.md:42-57` — every endpoint requires auth, so an
  unauthenticated `curl` proves nothing:

  ```bash
  npm run seed                 # prints one credential per organisation
  export TOKEN=<token printed by the seed>
  curl -sS -H "Authorization: Bearer $TOKEN" \
    "http://localhost:$PORT/v1/programs/b1b2c3d4-0001-4000-8000-000000000011/availability"
  ```

  Confirm one `info` record for that request, correlation id present, JSON shape byte-identical to
  before the change (SC-004, US2/AC2, FR-003). Nothing needs commenting out anywhere: the script does not export
  `LOG_LEVEL`, so this *is* the absent-key path.
- [ ] T015 [US2] Run quickstart S-005: `LOG_LEVEL=verbose ./scripts/dev-stack.sh`. The API MUST
  fail before it listens, with the message
  `Config validation error: "LOG_LEVEL" must be one of [trace, debug, info, warn, error, fatal, silent]`
  (verified byte-for-byte against `@nestjs/config@4.0.4` `config.module.js:96` and joi 18.2.9). It
  MUST NOT fall back to a default, and it MUST NOT fail on `"DATABASE_URL" is required` — that
  would mean the run bypassed the script's exported environment (SC-005, US2/AC3, FR-002).
- [ ] T016 [US2] Run quickstart S-006: `LOG_LEVEL= ./scripts/dev-stack.sh` MUST start normally at
  `info`, reach a listening state — verify with `curl -sf "http://localhost:$PORT/health"` exiting
  0 from a second shell — and emit no validation error — confirming the `.empty('')`
  behaviour from T004 (spec.md empty-value edge case). Ctrl-C afterwards.

- [ ] T017 [US2] Quickstart S-007 — the **running-service** half of FR-008, which no unit test can reach. T003 case (h) already proves the `redact` *configuration* is level-independent; this proves the censoring actually happens at the most verbose level. With the stack up, run `LOG_LEVEL=trace ./scripts/dev-stack.sh`, issue the authenticated request from T014, and confirm the emitted record shows `"authorization":"[redacted]"` rather than the bearer token. Raising verbosity must never put a credential into a record (FR-008, Constitution V). Do **not** re-run `test/unit/logger-config.spec.ts` here — T009 owns that.

**Checkpoint**: The setting is operable end to end, in both directions, with a loud failure on a typo.

---

## Phase 5: User Story 3 - Keep the environment contract honest (Priority: P3)

**Goal**: The published template and the validated schema declare the same key set, so the acceptance gate stays green.

**Independent Test**: Run the project's acceptance verification and confirm the environment-parity section passes.

- [ ] T018 [US3] Run quickstart S-008: `./scripts/verify-uat.sh` MUST pass, and its section 6 MUST report the `.env.example` and `src/config/env.schema.ts` key sets identical with `LOG_LEVEL` present in both (SC-006, FR-007, US3/AC1).
- [ ] T019 [US3] Run `npm run docs:verify` and confirm PASS on all five sections. If it fails on `documentation unit specs` with `Cannot find package`, run `npm ci` first — that is a local install gap, not a code defect (this exact failure was diagnosed and resolved on `9b2daa9`).

**Checkpoint**: All gates green. Feature complete.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T020 [P] Document the setting in `README.md` per FR-010: its name, the seven accepted values, the `info` default, the `warn` test-run default, and the `LOG_LEVEL=info npm test` recipe for restoring full records for one run. Use no hardcoded host or port — ports are per-worktree.
- [ ] T021 [P] Record the trade-off in `docs/ASSUMPTIONS.md` as Constitution VII requires: a `test`-profile process defaults to `warn` and is therefore quieter than a deployed one; deliberate-refusal suites still emit one `warn` record per 4xx, which is wanted output rather than residue to suppress (research.md R-005, R-009).
- [ ] T022 Run the full gate set `npm run typecheck && npm run lint && npm run build && npm run test:cov` and confirm all green with coverage above the 80% global floor (baseline 95.72% statements / 84.37% branches).
- [ ] T023 Commit T004a, T004, T005, T006 and T007 together as `feat: make log verbosity configurable through LOG_LEVEL`, with T003/T009's spec in the same commit or the one immediately preceding it. The schema and template MUST NOT be split across commits.

---

## Dependencies

**Story completion order**: US1 → US2 → US3. All three read the same Phase 2 change; they are ordered by the value they verify, not by technical coupling.

```text
Phase 1 (T001-T002)  baseline capture
        ↓
Phase 2 (T003 RED → T004a → T004, T005 → T006 → T007 → T008 GREEN)   ← blocks everything
        ↓
Phase 3 US1 (T009-T013)   ← MVP; closes the reported defect
        ↓
Phase 4 US2 (T014-T017)
        ↓
Phase 5 US3 (T018-T019)
        ↓
Phase 6 Polish (T020-T023)
```

**Hard constraints**:

- T004 and T005 MUST ship in one commit (`verify-uat.sh` §6 parity gate).
- T003 MUST be observed failing before T004 (Constitution VI).
- T001 MUST run before T004, or SC-002 and SC-003 have no before-state to compare against.
- T006 depends on T004 and T004a: `config.getOrThrow('LOG_LEVEL')` throws until the key exists,
  and `buildPinoHttpOptions` does not exist until the extraction lands.
- T004a is a pure behavioural move, but **not** a literal copy: the extracted object needs the
  `: Options` return annotation to keep its arrow parameters typed. Judge it by behaviour, not by
  diff-identity. A `TS7006` after T004a means the annotation was dropped, not that the move was
  wrong.
- T007 (kafkajs) is independent of T003-T006 and may be done any time in Phase 2, but it MUST
  precede T010, whose `tail -25` criterion it protects.

## Parallel Execution Opportunities

Genuinely small — this feature touches four files and two of them must move together.

- **Phase 1**: T002 runs alongside T001.
- **Phase 6**: T020 and T021 touch different files (`README.md`, `docs/ASSUMPTIONS.md`) and can run together.
- **Phase 2**: T007 (kafkajs) is independent and can run alongside T003-T006. Otherwise T003→T004a→T004→T006→T008 is a strict chain.
- **Phases 3-5**: no parallelism, and every story task is a verification run whose result depends on the previous one being green.

## Implementation Strategy

**MVP = Phase 1 + Phase 2 + Phase 3 (T001-T013, including T004a).** That closes the reported defect: the suite goes quiet, the verdict is readable, and nothing else moves. US2 and US3 are consequences of the same change rather than separate builds — US2 verifies the operator-facing half of a setting that already exists after Phase 2, and US3 verifies a gate that Phase 2 already had to satisfy to be committable at all.

**Incremental delivery**: the whole feature is one commit's worth of code (T004a-T007) plus verification and documentation. Splitting it further would break the parity gate. Ship it as one PR.
