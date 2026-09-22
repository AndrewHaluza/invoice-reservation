# Execution Plan: Make log verbosity configurable through LOG_LEVEL

Source of truth: `specs/005-configurable-log-level/tasks.md` (24 tasks, T001–T023 plus T004a),
plus `plan.md`, `research.md`, `contracts/log-level.env.md`, `quickstart.md` in the same
directory. This plan restates that content as self-contained executor tasks. Where the two
disagree, this file wins — it is the one the executor reads.

## Goal

`LoggerModule` in `src/app.module.ts` takes its pino `level` from a joi-validated `LOG_LEVEL`
environment variable that defaults to `warn` under `NODE_ENV=test` and `info` everywhere else,
so a full `npm test` run emits zero routine per-request records and its verdict is readable in
the last 25 lines of output, while a deployed service that sets nothing behaves exactly as today.

## Current State

Verified by reading the files, 2026-09-22, branch `develop` at `9b2daa9`:

- `src/app.module.ts:33-63` declares `LoggerModule.forRoot({ pinoHttp: { genReqId, customProps,
  redact, formatters } })` with **no `level` key**. pino therefore applies its default `info` and
  `pino-http` writes one record per HTTP request.
- `src/app.module.ts:1` imports `type { IncomingMessage } from 'node:http'`; line 19 declares
  `type CorrelationRequest = IncomingMessage & { correlationId?: string }`; lines 12-16 import
  `CORRELATION_HEADER`, `CorrelationMiddleware`, `resolveCorrelationId` from `./shared/correlation`.
  `CorrelationMiddleware` is used by `configure()` further down the file and must survive.
- `src/config/env.schema.ts` has 6 `.required()` keys — `DATABASE_URL`, `REDIS_URL`,
  `KAFKA_BROKERS`, `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD`, `JWT_SECRET` — and no `LOG_LEVEL`.
  `API_DOCS_ENABLED` (lines 6-8) is the existing `NODE_ENV`-dependent-default precedent.
- `src/treasury/kafka.config.ts` `buildKafkaConfig` returns `{ brokers, clientId, ssl, sasl?,
  retry }` with **no `logLevel`**, so kafkajs runs at its default `INFO`.
- `src/config/logger.config.ts` does **not** exist.
- `test/unit/logger-config.spec.ts` does **not** exist.
- `test/integration/read-your-writes.spec.ts:23` sets `const TRIALS = 10_000`, two requests each.
- `scripts/verify-uat.sh` §6 (lines 115-132) matches schema keys with `/^\s*([A-Z][A-Z0-9_]*)\s*:/gm`
  and template keys with `/^\s*([A-Z][A-Z0-9_]*)\s*=/gm`, failing UAT on any drift.
- `scripts/dev-stack.sh` **never writes a `.env`**. It `export`s the required keys into its own
  process (lines 51-83); `print_env()` (lines 89-103) is a fixed heredoc that never contains
  `LOG_LEVEL`; the default `run` subcommand (line 214) does `stack_up` then `npm run start:dev`.
- A clean worktree has **no `.env` file**. `package.json` depends on `nestjs-pino` and `pino-http`
  (11.0.0); **`pino` is not a direct dependency**.
- `specs/005-configurable-log-level/` is untracked.

## Target State

- `src/config/logger.config.ts` exports `buildPinoHttpOptions(level: string): Options`.
- `src/config/env.schema.ts` declares `LOG_LEVEL` and `.env.example` declares it too, in one commit.
- `src/app.module.ts` uses `LoggerModule.forRootAsync` with `ConfigService` injected.
- `src/treasury/kafka.config.ts` and four test-only raw-client sites run kafkajs at `ERROR` under test.
- `test/unit/logger-config.spec.ts` covers cases (a)–(i) below.
- `README.md` and `docs/ASSUMPTIONS.md` document the setting and its trade-off.

## Scope

### In Scope

- The five source/config files named above, one new source file, one new unit spec, four
  test-only kafkajs call sites, two docs files.
- Verification runs S-001…S-003, S-008, S-009 from `quickstart.md` (the automatable ones).

### Out of Scope

- Any change to Jest config. Jest sets `NODE_ENV=test` itself; all four configs inherit the
  quiet default for free.
- Any rewording of the `genReqId` / `customProps` / `redact` / `formatters` blocks. They move
  unchanged; rewording risks FR-008 and FR-009.
- Runtime reconfiguration, per-component levels, log routing to a file.
- **Phase 4 (US2, T014–T017) is deferred — see Task 10.** Those four checks each start a
  foreground service ended by Ctrl-C and cannot complete in an unattended executor session.

## Key Decisions

1. **`warn` under test, not `silent`.** A genuine service-side error must still print beneath a
   failing test. Deliberate-refusal suites keep emitting one `warn` record per 4xx; that is
   wanted output, recorded as such in `docs/ASSUMPTIONS.md` (Task 8), never suppressed.
2. **`NODE_ENV`-dependent joi default**, mirroring `API_DOCS_ENABLED`. Evaluated once at module
   load — which is why Task 2's spec re-imports the module per case.
3. **`.empty('')`** so `LOG_LEVEL=` takes the default rather than refusing the boot. Its position
   relative to `.default()` is irrelevant (verified in joi 18.2.9, both orders yield `info`).
4. **`forRootAsync` with `ConfigService`, never `process.env` directly** — reading the env
   directly bypasses joi and defeats the refuse-on-typo requirement.
5. **The `: Options` return annotation on `buildPinoHttpOptions` is load-bearing.** Today the
   arrow parameters are contextually typed by `LoggerModule.forRoot`'s parameter; in a standalone
   literal, `strict` + `noImplicitAny` yield three `TS7006` errors without it.
6. **kafkajs is silenced too**, at `ERROR` under test. It is a second log source `LOG_LEVEL` does
   not govern, its records are uppercase-`INFO` with no `req` field so the detector cannot see
   them, and one teardown line between the last test and the summary defeats the whole goal.
   `ERROR` rather than `NOTHING`, so a real broker failure survives — consistent with `warn`.
7. **The routine-record detector is severity-qualified.** `grep -cE '"level":"info".*"req"'`
   counts routine records; `grep -cE '"level":"warn".*"req"'` counts refusals and is expected to
   be non-zero. A bare `grep -c '"req"'` is wrong and would make the refusal records look like
   a failure.

## Execution Order

### Task 1: Capture the baseline and get onto a feature branch

#### Objective

Produce the before-state that the after-state is measured against, and a branch to work on.

#### Files

- `/tmp/005-before.log` — created, the raw `npm test` output.
- `/tmp/005-baseline.txt` — created, the extracted counts. Task 7 reads it back.

No repository file is modified except the git branch and one commit of the untracked spec dir.

#### Implementation

1. Confirm a Docker daemon is running (`docker info` exits 0). `npm test` includes
   `test/integration` and `test/contract`, both testcontainers-backed, and fails without one.
2. Run:

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

3. Then:

   ```bash
   git switch -c 005-configurable-log-level
   git add specs/005-configurable-log-level
   git commit -m "docs: spec-kit artifacts for configurable log level"
   git status --short -- src test .env.example README.md docs/ASSUMPTIONS.md
   ```

#### Constraints

- Do not change any source file in this task.
- Record whatever `verdict` and `suites` actually say. Do not assume a number; the baseline moves
  as `develop` moves, and Task 7 compares against this file, never against a literal.
- The clean-tree check covers `src/`, `test/`, `.env.example`, `README.md`, `docs/ASSUMPTIONS.md`
  only — the spec artifacts are committed in step 3 precisely so a bare clean-tree check does not
  trip on them.

#### Edge Cases

- **`npm test` fails on `develop`.** That is still a valid baseline: record the failing verdict
  and continue. Task 7's criterion is "identical to the baseline", not "green".
- **No Docker daemon.** Stop and report; the baseline cannot be captured without one.

#### Verification

```bash
cat /tmp/005-baseline.txt
git branch --show-current
```

Expected:
- `routine=` a number in the tens of thousands.
- `git branch --show-current` prints `005-configurable-log-level`.
- The `git status --short` in step 3 printed nothing.

#### Completion Criteria

- [ ] `/tmp/005-before.log` exists and is non-empty.
- [ ] `/tmp/005-baseline.txt` holds four lines: `routine=`, `refusal=`, `verdict=`, `suites=`.
- [ ] Current branch is `005-configurable-log-level` and the spec artifacts are committed.

---

### Task 2: Write the RED unit spec

#### Objective

Create `test/unit/logger-config.spec.ts` with every case written out as a real `it()` block, and
observe it fail for the right reason. This is the Constitution VI red step and must precede Task 3.

#### Files

- `test/unit/logger-config.spec.ts` — created.

#### Implementation

Three properties of this repository make the obvious spec wrong. The structure below is mandatory,
not a suggestion:

1. **`envSchema` has six `.required()` keys.** With joi's default `abortEarly: true`,
   `envSchema.validate({ LOG_LEVEL: 'verbose' })` returns `"DATABASE_URL" is required` and applies
   **no defaults** — every naive assertion reads `undefined` and fails for the wrong reason.
   Validate against a complete baseline with `{ abortEarly: false, allowUnknown: true }`, matching
   `src/config/configuration.module.ts:11`, and assert with `toContain`.
2. **The `NODE_ENV` ternary in the schema is evaluated once, at module import.** Jest sets
   `NODE_ENV=test` before the file loads, so the default is baked to `warn` for the whole spec.
   Setting `process.env.NODE_ENV` inside a test case has no effect. Re-import per case with
   `jest.resetModules()`.
3. **`pino` is not a direct dependency.** Do not import it. Assert the level as a string.

Write the file with this skeleton, replacing each lettered comment with a real `it()`:

```ts
import type { ObjectSchema } from 'joi';
import { buildPinoHttpOptions } from '../../src/config/logger.config';

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
  // (g) for each of LEVELS: buildPinoHttpOptions(l).level === l
  // (h) buildPinoHttpOptions('error') and buildPinoHttpOptions('trace') have
  //     deep-equal `redact` — paths req.headers.authorization, req.headers.cookie,
  //     req.headers["x-api-key"], censor '[redacted]'
  // (i) genReqId, customProps and formatters are all functions/present
});
```

Every case validates as `schema.validate({ ...VALID_ENV, ...overrides }, OPTS)`.

#### Constraints

- Do not create `src/config/logger.config.ts` in this task — Task 3 does that.
- Do not import `pino`.
- Do not remove the `eslint-disable-next-line @typescript-eslint/no-require-imports` comment; the
  rule errors without it.
- **Do not assert that pino's numeric ordering puts `warn` below `error`.** That is a library
  constant (30 < 50), can never fail, and would give false assurance. The real proof that nothing
  below the threshold is emitted is Task 7's measured record count.

#### Edge Cases

- **Case (c), empty string.** `LOG_LEVEL: ''` must resolve to the default, not raise. This is what
  `.empty('')` in Task 4 buys.
- **Case (b), the error message.** Assert with `toContain('LOG_LEVEL')` and `toContain` on each of
  the seven accepted values, not on an exact string — joi's phrasing around the list is not
  something this spec should pin.

#### Verification

```bash
npx jest test/unit/logger-config.spec.ts
```

Expected:
- It **FAILS**, with `TS2307: Cannot find module '../../src/config/logger.config'`.
- A failure reading `Your test suite must contain at least one test` means the lettered comments
  were never written out. That is not a RED step, it is an empty file — go back and write them.

#### Completion Criteria

- [ ] `test/unit/logger-config.spec.ts` exists.
- [ ] It contains nine real `it()` blocks covering (a) through (i).
- [ ] `npx jest test/unit/logger-config.spec.ts` fails with `TS2307` on the missing module.

---

### Task 3: Extract the pinoHttp options into `src/config/logger.config.ts`

#### Objective

Move the four pinoHttp blocks out of `src/app.module.ts` into a unit-testable factory, adding the
`level` parameter. Pure behavioural extraction.

#### Files

- `src/config/logger.config.ts` — created.

`src/app.module.ts` is **not** edited in this task; Task 5 does that.

#### Implementation

Create the file with exactly this content:

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

#### Constraints

- **The `: Options` return annotation must not be dropped.** Without it, `strict` +
  `noImplicitAny` produce three `TS7006: Parameter implicitly has an 'any' type` errors on `req`,
  `req` and `label`, because the contextual typing that `LoggerModule.forRoot`'s parameter used to
  supply is gone in a standalone literal.
- Do not introduce `any` or a non-null assertion. The constitution's technology constraints forbid
  both without an inline justification.
- Do not reword `genReqId`, `customProps`, `redact` or `formatters`. Behaviour must be identical.
- `redact` must not branch on `level` in any way.

#### Edge Cases

- **`tsc` reports that `Options` needs type arguments.** Use
  `Options<IncomingMessage, ServerResponse>`, importing `ServerResponse` as a type from
  `node:http`. Do **not** fall back to `any`.
- **A boundaries lint error.** `eslint.config.mjs` allows `config → shared, config`, so the
  `../shared/correlation` import is permitted. If it errors, stop and report — do not edit
  `eslint.config.mjs`.

#### Verification

```bash
npx tsc --noEmit
```

Expected:
- Exit 0, with no `TS7006` and no error naming `logger.config.ts`.
- `npx jest test/unit/logger-config.spec.ts` now gets past `TS2307` and fails instead on the
  `LOG_LEVEL` schema cases (d)/(e), which Task 4 fixes. Cases (g), (h), (i) should already pass.

#### Completion Criteria

- [ ] `src/config/logger.config.ts` exists with the content above, `: Options` included.
- [ ] `npx tsc --noEmit` exits 0.
- [ ] The spec's `TS2307` is gone; remaining failures are `LOG_LEVEL` default assertions.

---

### Task 4: Declare `LOG_LEVEL` in the schema and the template

#### Objective

Add the joi key and the matching `.env.example` entry. **Both files, one task, one commit** — the
UAT parity gate fails on drift.

#### Files

- `src/config/env.schema.ts` — modified, one key added.
- `.env.example` — modified, one key plus a comment block added.

#### Implementation

1. In `src/config/env.schema.ts`, immediately after the `API_DOCS_ENABLED` entry (which ends at
   line 8 with `.default(process.env.NODE_ENV === 'production' ? 'false' : 'true'),`), insert:

   ```ts
   LOG_LEVEL: Joi.string()
     .valid('trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent')
     .empty('')
     .default(process.env.NODE_ENV === 'test' ? 'warn' : 'info'),
   ```

2. In `.env.example`, add:

   ```dotenv
   # Log verbosity: trace | debug | info | warn | error | fatal | silent
   # Defaults to info; a test run defaults to warn. Raise for one run with:
   #   LOG_LEVEL=info npm test
   LOG_LEVEL=info
   ```

#### Constraints

- `.empty('')` is required. A bare `Joi.string()` rejects `''`, so without it `LOG_LEVEL=` would
  refuse the boot instead of taking the default. Its position relative to `.default()` does **not**
  matter (verified in joi 18.2.9, both orders yield `info`); keep the order above for consistency.
- Both edits land together. `scripts/verify-uat.sh` §6 asserts the key sets are identical.
- Do not add any other key to either file.

#### Edge Cases

- **The comment lines in `.env.example`.** The gate's template regex is
  `/^\s*([A-Z][A-Z0-9_]*)\s*=/gm`; `#`-prefixed lines do not match it, so the `LOG_LEVEL=info`
  recipe inside the comment is safe and will not be read as a second declaration.

#### Verification

```bash
npx jest test/unit/logger-config.spec.ts
npx tsc --noEmit
node -e "const s=require('./src/config/env.schema');" 2>/dev/null || true
grep -c '^LOG_LEVEL=' .env.example
```

Expected:
- The spec **PASSES** in full — all nine cases (a)–(i).
- `npx tsc --noEmit` exits 0.
- `grep -c '^LOG_LEVEL=' .env.example` prints `1`.

#### Completion Criteria

- [ ] `LOG_LEVEL` is declared in `src/config/env.schema.ts` exactly as above.
- [ ] `LOG_LEVEL=info` plus the three comment lines are in `.env.example`.
- [ ] `test/unit/logger-config.spec.ts` passes completely. This is the RED→GREEN transition.

---

### Task 5: Convert `LoggerModule` to `forRootAsync`

#### Objective

Feed the validated `LOG_LEVEL` into pino, and remove the code that Task 3 moved out.

#### Files

- `src/app.module.ts` — modified.

#### Implementation

1. Replace the whole `LoggerModule.forRoot({ ... })` block (currently lines 33-63, starting
   `LoggerModule.forRoot({` and ending `}),` after the `formatters` block) with:

   ```ts
   LoggerModule.forRootAsync({
     inject: [ConfigService],
     useFactory: (config: ConfigService) => ({
       pinoHttp: buildPinoHttpOptions(config.getOrThrow<string>('LOG_LEVEL')),
     }),
   }),
   ```

2. Add `import { buildPinoHttpOptions } from './config/logger.config';`.
3. Delete the now-unused `import type { IncomingMessage } from 'node:http';` (line 1) and the local
   `type CorrelationRequest = IncomingMessage & { correlationId?: string };` (line 19).
4. From the `./shared/correlation` import (lines 12-16), remove `CORRELATION_HEADER` and
   `resolveCorrelationId` **only if nothing else in the file still uses them**. The import
   statement itself **stays** — `CorrelationMiddleware` from it is still used by `configure()`.

#### Constraints

- **Do not read `process.env` in this file.** That bypasses joi and defeats the refuse-on-typo
  requirement. `config.getOrThrow('LOG_LEVEL')` is safe on the absent-key path: `@nestjs/config`
  writes joi-resolved defaults back into `process.env` before the factory runs.
- `ConfigService` is already imported at line 3 — do not add a second import.
- Do not touch `TypeOrmModule.forRootAsync` or any other module in the `imports` array.

#### Edge Cases

- **An unused-import lint error after step 4.** Let `npm run lint` decide which names to drop
  rather than guessing; it flags unused imports. If it flags nothing, the deletion in step 3/4 was
  already correct.

#### Verification

```bash
npm run typecheck && npm run lint
grep -n 'process.env' src/app.module.ts
```

Expected:
- Both commands exit 0, with no `any`, no non-null assertion, no boundary violation.
- `grep -n 'process.env' src/app.module.ts` prints nothing.

#### Completion Criteria

- [ ] `src/app.module.ts` uses `LoggerModule.forRootAsync` with `ConfigService` injected.
- [ ] The four pinoHttp blocks no longer appear in `src/app.module.ts`.
- [ ] `npm run typecheck && npm run lint` both exit 0.

---

### Task 6: Silence kafkajs under test

#### Objective

Stop kafkajs writing its own `INFO` records, which `LOG_LEVEL` does not govern and which would
otherwise sit between the last test and the result summary.

#### Files

- `src/treasury/kafka.config.ts` — modified.
- `test/support/redpanda-container.ts` — modified around line 25.
- `test/integration/stream-lag.spec.ts` — modified at lines 88 and 160.
- `test/performance/sc-002a-treasury-visibility.spec.ts` — modified around line 178.

#### Implementation

1. In `src/treasury/kafka.config.ts`, import `{ logLevel }` from `kafkajs` **as a value**, not a
   type (the file currently has only `import type { KafkaConfig } from 'kafkajs';` — add a
   separate value import). Then add to the object returned by `buildKafkaConfig`, alongside
   `retry`:

   ```ts
   logLevel: config.get<string>('NODE_ENV') === 'test' ? logLevel.ERROR : logLevel.INFO,
   ```

2. At each of the four test-only sites, which construct a raw `new Kafka({...})` client rather than
   going through `buildKafkaConfig`, add `logLevel: logLevel.ERROR` to the constructor object,
   importing `{ logLevel }` from `kafkajs` in each file.

#### Constraints

- Use `ERROR`, not `NOTHING`. A genuine broker failure must still reach the output — the same
  reasoning as choosing `warn` over `silent` for pino.
- Do not change `brokers`, `clientId`, `ssl`, `sasl` or `retry`.
- Do not change the level for non-test environments: production and development stay at `INFO`.

#### Edge Cases

- **A fifth raw-client site.** `grep -rn "new Kafka(" src test` finds seven sites; three go through
  `buildKafkaConfig` and are covered by step 1, four are the ones listed above. If the grep finds a
  site not in that list, add `logLevel: logLevel.ERROR` there too if it is under `test/`, and stop
  and report if it is under `src/`.
- **The performance suite.** `test/performance/` is in `jest.config.ts`'s `testPathIgnorePatterns`,
  so it cannot affect the `npm test` output. It is included for consistency, because
  `npm run test:perf` floods identically.

#### Verification

```bash
grep -rn "new Kafka(" src test
npm run typecheck && npm run lint
```

Expected:
- Seven `new Kafka(` sites; the four test-only ones each now carry `logLevel: logLevel.ERROR`.
- Both commands exit 0.

#### Completion Criteria

- [ ] `buildKafkaConfig` returns a `logLevel` that is `ERROR` under `NODE_ENV=test`, `INFO` otherwise.
- [ ] All four test-only raw-client sites pass `logLevel: logLevel.ERROR`.
- [ ] `npm run typecheck && npm run lint` both exit 0.

---

### Task 7: Verify User Story 1 — the test run goes quiet and the verdict is unchanged

#### Objective

Measure the after-state and prove the reported defect is closed, with no test outcome changed.
This is the MVP checkpoint.

#### Files

- `/tmp/005-after.log` — created.

No repository file is modified. **Write no new assertion in this task.**

#### Implementation

1. **Confirm, do not duplicate.** Open `test/unit/logger-config.spec.ts` and confirm cases (g) and
   (h) exist as real `it()` blocks and pass: (g) `buildPinoHttpOptions(l).level === l` for each of
   the seven levels, and (h) deep-equal `redact` between `buildPinoHttpOptions('trace')` and
   `buildPinoHttpOptions('error')` with paths `req.headers.authorization`, `req.headers.cookie`,
   `req.headers["x-api-key"]` and censor `[redacted]`. Confirm no `redact` value in
   `src/config/logger.config.ts` branches on the level. If (g) or (h) is missing, go back and
   finish Task 2 rather than adding a second copy here.

2. Run the after-state capture:

   ```bash
   npm test 2>&1 | tee /tmp/005-after.log
   grep -cE '"level":"info".*"req"' /tmp/005-after.log     # MUST be 0
   grep -cE '"level":"warn".*"req"' /tmp/005-after.log     # expected NON-ZERO
   tail -25 /tmp/005-after.log
   ```

3. Compare the verdict against the baseline:

   ```bash
   diff <(grep -E '^(Tests|Test Suites):' /tmp/005-before.log | tail -2) \
        <(grep -E '^(Tests|Test Suites):' /tmp/005-after.log  | tail -2)
   ```

4. Confirm failures still print:

   ```bash
   npm run test:e2e 2>&1 | tee /tmp/005-e2e.log
   grep '"level":"warn"' /tmp/005-e2e.log | head
   grep -cE '"level":"info".*"req"' /tmp/005-e2e.log       # MUST be 0
   ```

5. Confirm one variable restores the records:

   ```bash
   LOG_LEVEL=info npx jest test/integration/read-your-writes.spec.ts 2>&1 \
     | grep -cE '"level":"info".*"req"'                    # MUST be NON-ZERO
   ```

#### Constraints

- **Do not count `"req"` unqualified.** The `warn` default deliberately keeps 4xx records, which
  also carry a `req` object. Six in-scope suites provoke a 4xx by design —
  `test/integration/currency-mismatch.spec.ts`, `release-nets-to-zero.spec.ts`,
  `reserve-endpoint.spec.ts`, `cancellation.spec.ts`, `test/contract/reservations.contract.spec.ts`,
  `releases.contract.spec.ts`.
- A non-zero `warn`+`req` count is the **correct** outcome and MUST NOT be suppressed by lowering
  the level to `silent`.
- Compare against `/tmp/005-before.log`, never against a literal number in this document.

#### Edge Cases

- **`tail -25` still shows a `"logger":"kafkajs"` line.** Task 6 was not applied to all four call
  sites. Fix Task 6; do not touch `LOG_LEVEL`.
- **The step-3 diff produces output.** A test outcome changed. This is a **blocker** — stop and
  report. Do not reconcile it by editing a test.
- **`/tmp/005-before.log` is missing.** Task 1 was skipped or the temp file was cleaned. Stop and
  report; there is no before-state to compare against.

#### Verification

Expected:
- Step 2: `grep -cE '"level":"info".*"req"'` prints `0`; the `warn` count is non-zero;
  `tail -25` shows the Jest result summary with no log records above it.
- Step 3: **no output**.
- Step 4: `warn` refusal records are present; the `info` count is `0`.
- Step 5: a non-zero count.

#### Completion Criteria

- [ ] Zero routine `info`+`req` records in `/tmp/005-after.log`.
- [ ] The Jest summary is visible in `tail -25` with no log records above it.
- [ ] The before/after verdict diff is empty.
- [ ] `npm run test:e2e` still shows `warn` refusal records.
- [ ] `LOG_LEVEL=info` on one suite restores a non-zero `info`+`req` count.

---

### Task 8: Document the setting and record the trade-off

#### Objective

Satisfy the documentation requirement and the observability principle's disclosure obligation.

#### Files

- `README.md` — modified, a subsection under `## Configuration`.
- `docs/ASSUMPTIONS.md` — modified, one new entry.

#### Implementation

1. In `README.md`, under the existing `## Configuration` section (currently lines 91-95), document
   `LOG_LEVEL`: its name, the seven accepted values `trace | debug | info | warn | error | fatal |
   silent`, the `info` default, the `warn` default under a test run, and the recipe
   `LOG_LEVEL=info npm test` for restoring full per-request records for a single run without
   editing any file.
2. In `docs/ASSUMPTIONS.md`, record: a `test`-profile process defaults to `warn` and is therefore
   quieter than a deployed one; deliberate-refusal suites still emit one `warn` record per 4xx,
   which is wanted output rather than residue to suppress.

#### Constraints

- **No hardcoded host or port anywhere in the added text.** Ports are per-worktree;
  `./scripts/dev-stack.sh env` prints the resolved set. The README already follows this.
- Do not restructure either file. Add to the existing sections.

#### Edge Cases

- **`docs/ASSUMPTIONS.md` has a numbered or dated entry convention.** Read the file first and match
  whatever convention is already there rather than inventing one.

#### Verification

```bash
grep -n 'LOG_LEVEL' README.md docs/ASSUMPTIONS.md
grep -nE 'localhost:(3000|5432|6379|9092)' README.md
```

Expected:
- `LOG_LEVEL` appears in both files.
- The second grep prints nothing new that this task introduced.

#### Completion Criteria

- [ ] `README.md` names `LOG_LEVEL`, its seven values, both defaults, and the one-run recipe.
- [ ] `docs/ASSUMPTIONS.md` records the quiet-test-default trade-off and the expected `warn` residue.
- [ ] Neither addition hardcodes a host or port.

---

### Task 9: Run the full gate set

#### Objective

Confirm every project gate is green before the change is committed.

#### Files

None modified.

#### Implementation

```bash
./scripts/verify-uat.sh
npm run docs:verify
npm run typecheck && npm run lint && npm run build && npm run test:cov
```

#### Constraints

- Do not edit `scripts/verify-uat.sh` or `scripts/verify-docs.sh` to make a gate pass.
- Do not lower the coverage threshold.

#### Edge Cases

- **`npm run docs:verify` fails on `documentation unit specs` with `Cannot find package`.** Run
  `npm ci` first and retry. That is a local install gap, not a code defect — this exact failure was
  diagnosed and resolved on commit `9b2daa9`.
- **`verify-uat.sh` §6 reports a key-set mismatch.** Task 4 landed only one of its two edits. Go
  back to Task 4.

#### Verification

Expected:
- `./scripts/verify-uat.sh` prints PASS, and its section 6 reports the `.env.example` and
  `src/config/env.schema.ts` key sets identical with `LOG_LEVEL` present in both.
- `npm run docs:verify` prints PASS on all five sections.
- `typecheck`, `lint`, `build` and `test:cov` all exit 0, with coverage above the 80% global floor
  (baseline 95.72% statements / 84.37% branches).

#### Completion Criteria

- [ ] `verify-uat.sh` passes including §6 parity.
- [ ] `docs:verify` passes.
- [ ] `typecheck`, `lint`, `build`, `test:cov` all exit 0 and coverage clears 80%.

---

### Task 10: Commit

#### Objective

Land the change as one reviewable commit with the schema and template together.

#### Files

`src/config/logger.config.ts`, `src/config/env.schema.ts`, `.env.example`, `src/app.module.ts`,
`src/treasury/kafka.config.ts`, the four test-only kafkajs sites,
`test/unit/logger-config.spec.ts`, `README.md`, `docs/ASSUMPTIONS.md`.

#### Implementation

Commit everything from Tasks 2–8 as:

```
feat: make log verbosity configurable through LOG_LEVEL
```

The spec from Task 2 goes in this commit or in the one immediately preceding it.

#### Constraints

- **`src/config/env.schema.ts` and `.env.example` MUST NOT be split across commits.** The parity
  gate fails on any intermediate state where only one of them has the key.
- Do not open a pull request in this task unless the operator asks.

#### Edge Cases

- **A pre-commit hook rejects the commit.** Read its output and fix the cause; do not use
  `--no-verify`.

#### Verification

```bash
git show --stat HEAD
git status --short
```

Expected:
- One commit touching the files listed above.
- `git status --short` prints nothing.

#### Completion Criteria

- [ ] One commit named `feat: make log verbosity configurable through LOG_LEVEL`.
- [ ] Schema and template are in that same commit.
- [ ] The working tree is clean.

---

### Task 11 (MANUAL — do not attempt unattended): Verify User Story 2

#### Objective

Confirm an operator can raise and lower a running service's verbosity, and that a typo refuses the
boot. **This task starts a foreground service and is ended by the operator with Ctrl-C. An
automated executor will hang on it. Skip it and report it as deferred unless a human is driving
the session.**

#### Files

None modified.

#### Implementation

**How to run the service.** A clean worktree has no `.env` and six env keys are `.required()`.
`scripts/dev-stack.sh` does **not** create a `.env` — it `export`s the keys into its own process
(lines 51-83) and those die with the subshell. So `./scripts/dev-stack.sh up` followed by a
separate `npm run start` fails on `"DATABASE_URL" is required`, which says nothing about
`LOG_LEVEL`. Every check below runs the service **through** the script, whose default `run`
subcommand (line 214) does `stack_up` then `npm run start:dev` inside its own exported
environment. `LOG_LEVEL` is inherited from the invoking shell — the script never sets or
overwrites it — so prefixing works:

```bash
LOG_LEVEL=<value> ./scripts/dev-stack.sh
```

1. **Absent value.** Confirm `env | grep -c '^LOG_LEVEL='` reports `0` *before* launching. Do not
   use `./scripts/dev-stack.sh env` for this — `print_env()` (lines 89-103) is a fixed heredoc that
   never contains `LOG_LEVEL` and so reports 0 unconditionally, proving nothing. Run
   `./scripts/dev-stack.sh`. The script exports `NODE_ENV=development`, so the expected resolved
   level is `info`. Issue an authenticated request using the recipe at `README.md:42-57` — every
   endpoint requires auth, so an unauthenticated curl proves nothing:

   ```bash
   npm run seed                 # prints one credential per organisation
   export TOKEN=<token printed by the seed>
   curl -sS -H "Authorization: Bearer $TOKEN" \
     "http://localhost:$PORT/v1/programs/b1b2c3d4-0001-4000-8000-000000000011/availability"
   ```

   Confirm one `info` record for that request, correlation id present, JSON shape byte-identical to
   before the change.

2. **Invalid value.** `LOG_LEVEL=verbose ./scripts/dev-stack.sh` MUST fail before it listens, with
   `Config validation error: "LOG_LEVEL" must be one of [trace, debug, info, warn, error, fatal, silent]`
   (verified byte-for-byte against `@nestjs/config@4.0.4` `config.module.js:96` and joi 18.2.9).

3. **Empty value.** `LOG_LEVEL= ./scripts/dev-stack.sh` MUST start normally at `info` and reach a
   listening state — verify with `curl -sf "http://localhost:$PORT/health"` exiting 0 from a second
   shell — with no validation error. Ctrl-C afterwards.

4. **Redaction at maximum verbosity.** `LOG_LEVEL=trace ./scripts/dev-stack.sh`, issue the
   authenticated request from step 1, and confirm the emitted record shows
   `"authorization":"[redacted]"` rather than the bearer token.

#### Constraints

- Ports are per-worktree. Never hardcode 5432/6379/9092. `./scripts/dev-stack.sh env` prints the
  resolved set.
- Stop each run with Ctrl-C — the script's EXIT trap tears the stack down.
- Step 4 proves the **running-service** half of the redaction requirement, which no unit test can
  reach. Do **not** re-run `test/unit/logger-config.spec.ts` here; Task 7 step 1 owns the
  configuration half.

#### Edge Cases

- **Step 2 fails on `"DATABASE_URL" is required` instead.** The run bypassed the script's exported
  environment — it was not launched through `./scripts/dev-stack.sh`. Retry correctly.
- **Step 1 finds `LOG_LEVEL` already exported in the shell.** `unset LOG_LEVEL` first; otherwise
  this is not the absent-key path.

#### Verification

Expected, per step: (1) exactly one `info` record for the request, correlation id present;
(2) the exact validation message, no fallback to a default, no listening socket; (3) a clean start
and a `curl -sf .../health` exiting 0; (4) `"authorization":"[redacted]"` in the trace-level record.

#### Completion Criteria

- [ ] Absent `LOG_LEVEL` yields `info` and today's record shape.
- [ ] `LOG_LEVEL=verbose` refuses the boot with the exact message above.
- [ ] `LOG_LEVEL=` starts normally at `info` and serves `/health`.
- [ ] `LOG_LEVEL=trace` censors the authorization header.

---

## Final Verification

1. The unit spec passes: `npx jest test/unit/logger-config.spec.ts`.
2. The full suite is quiet and its verdict is unchanged (Task 7).
3. Every project gate is green (Task 9).

Commands:

```bash
npm run typecheck && npm run lint && npm run build && npm run test:cov
./scripts/verify-uat.sh
npm run docs:verify
npm test 2>&1 | tee /tmp/005-final.log
grep -cE '"level":"info".*"req"' /tmp/005-final.log
tail -25 /tmp/005-final.log
```

Expected:
- All commands exit 0; coverage clears the 80% global floor.
- The `info`+`req` count is `0`.
- `tail -25` shows the Jest result summary with no log records above it.

## Executor Rules

1. Execute each task in a **separate sub-agent** with a fresh context; do not run multiple tasks
   inside one long-lived session.
2. Execute tasks strictly in numerical order.
3. Complete the current task and its verification before starting the next task.
4. Implement the solution described in the plan exactly.
5. Do not redesign architecture or substitute a different approach.
6. Do not add features, cleanup, abstractions, or refactors not explicitly required by the plan.
7. Do not omit planned behavior because another implementation appears simpler.
8. Do not reinterpret product requirements.
9. Do not make optional improvements.
10. Follow existing project conventions where the plan explicitly relies on them.
11. Run the verification specified for every task.
12. Mark a task complete only when its completion criteria are satisfied.
13. If implementation reveals information that does not affect the prescribed solution, continue
    execution.
14. Stop rather than improvise when the plan cannot be executed as written.
15. **Task 2 deliberately leaves the repository broken.** It creates a spec that imports a module
    Task 3 has not yet created, so `npx tsc --noEmit` fails with `TS2307` between Task 2 and
    Task 3, and the spec's `LOG_LEVEL` default cases fail between Task 3 and Task 4. Both are the
    required red step, not a defect. Do not create `src/config/logger.config.ts` early, do not
    stub it, and do not delete or skip the failing cases to get a green run.
16. **Task 11 is manual and is expected to be skipped** by an unattended executor. Skipping it is
    not a failure; report it as deferred. Tasks 1–10 are the fully automatable MVP plus gates.
