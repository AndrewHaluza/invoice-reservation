# Execution Plan: Phase 2 — Foundational (T009–T034)

## Goal

The shared money kernel, the full database schema with its append-only and limit-binding
enforcement, the `advancePosition` position arithmetic, the locking unit of work, the auth and
rate-limiting chain, observability, and the seed script all exist, are tested, and leave
`npm run lint`, `npm run typecheck`, `npm test`, `npm run build` and `npm run test:cov` green —
including the 80% coverage gate that has been failing by design since Phase 1.

## Current State

Established by direct inspection of `origin/develop` at `90372a7` (PR #1, merged):

- `src/` contains only `main.ts`, `app.module.ts`, `config/configuration.module.ts`,
  `config/env.schema.ts`. There is no domain code at all.
- **`src/config/data-source.ts` does not exist**, yet `package.json` already declares
  `"migration:run": "typeorm-ts-node-commonjs migration:run -d src/config/data-source.ts"`.
  That script is broken today. Task 4 creates the file.
- **`package.json` declares `"test:unit": "jest --selectProjects unit"` but `jest.config.ts`
  defines no `projects` key.** That script fails today. Task 4 fixes it.
- **`eslint.config.mjs` on `develop` still uses deprecated bare element-type selectors** in every
  `allow:` array (`allow: ['domain', 'shared']`). The corrected form was written as commit
  `94daf6a` on the Phase 1 branch but was **not** included in the merge. It emits a deprecation
  warning per lint run as soon as any file matches a `boundaries/elements` pattern — which this
  phase is the first to do. Task 1 lands it.
- `docker-compose.yml` defines `postgres` (16.10-alpine) and `redpanda` (v24.2.18) plus a
  `redpanda-init` topic bootstrapper. **There is no Redis service**, and no Redis client is
  installed, yet T030 requires a Redis-backed throttler store.
- `jest.config.ts` sets `coverageThreshold.global` to 80 on all four counters. `npm run test:cov`
  currently exits 1 because `src/**` is almost entirely uncovered. This is intentional and
  documented; it is a live gate, not a defect.
- `src/config/env.schema.ts` validates `NODE_ENV, PORT, DATABASE_URL, KAFKA_BROKERS,
  KAFKA_SASL_USERNAME, KAFKA_SASL_PASSWORD, KAFKA_CAPACITY_EVENTS_TOPIC, KAFKA_SNAPSHOTS_TOPIC,
  KAFKA_DLQ_TOPIC, JWT_SECRET, JWT_CLOCK_SKEW_SECONDS, SNAPSHOT_DELTA_GUARD_RATIO,
  RATE_LIMIT_READ_PER_MINUTE, RATE_LIMIT_WRITE_PER_MINUTE`. No `REDIS_URL`.
- Installed and available, no install needed: `@nestjs/typeorm` 11.0.3, `typeorm` 0.3.31, `pg`
  8.23.0, `@nestjs/throttler` 6.7.0, `@nestjs/jwt` 11.0.2, `@nestjs/terminus` 11.1.1,
  `nestjs-pino` 5.2.0, `pino-http` 11.0.0, `prom-client` 15.1.3, `joi` 18.2.9,
  `class-validator` 0.15.1, `testcontainers` + `@testcontainers/postgresql` 12.1.0.

## Target State

`src/` matches the directory layout in `plan.md` for everything Phase 2 owns: `shared/money`,
`shared/result`, `shared/correlation`, `capacity/domain/position.ts`,
`capacity/infrastructure/{entities,repositories,unit-of-work.ts}`, `migrations/`, `auth/`,
`observability/`, plus `scripts/seed.ts`. Phase 3 can begin without touching any of it.

## Scope

### In Scope
- tasks.md T009 through T034, inclusive.
- The unmerged `eslint.config.mjs` boundaries selector fix (Task 1).
- The three latent Phase 1 defects named in Current State: missing `data-source.ts`, broken
  `test:unit` script, absent Redis service.

### Out of Scope
- Any Kafka consumer, handler, DLQ or retry code (`src/treasury/**`) — that is Phase 4+.
- Any HTTP controller or DTO (`src/capacity/api/**`) — Phase 3.
- Any reserve/release/cancel policy or application service (`src/capacity/application/**`,
  `src/capacity/domain/policies/**`) — Phase 3.
- The `fx/` adapters. Task 2 creates the **conversion function** in `shared/money/convert.ts`
  only. The `FxRateProvider` port and its adapters belong to Phase 3.
- CI workflow creation. No GitHub Actions workflow exists; this plan does not add one.

## Key Decisions

1. **The boundaries fix ships first, as Task 1.** It is the commit that missed the Phase 1 merge.
   It must land before any `src/capacity/domain/**` file exists, otherwise every subsequent task's
   lint run is polluted with deprecation warnings and the executor may mistake them for its own
   regression.

2. **`ioredis` is pinned to `5.11.1`, not `6.0.0`.** `@nest-lab/throttler-storage-redis@1.2.0`
   declares `ioredis: ">=5.0.0"`, so both satisfy the peer range, but 6.0.0 is a brand-new major
   the storage package has not been released against. Verified on npm 2026-09-19.

3. **`REVOKE` on the ledger is made meaningful by a non-owner role, created in Postgres init, not
   in the migration.** A table's owner retains all privileges regardless of `REVOKE`, so issuing
   `REVOKE UPDATE, DELETE ON capacity_ledger_entry FROM app_role` while the application connects
   as the owning `capacity` user would be decorative — the append-only guarantee would not
   actually bind. Therefore: `docker/postgres-init.sql` creates the login role `capacity_app` and
   the group role `app_role`; migrations run as the owner `capacity`; the application connects as
   `capacity_app`. Role *existence* is infrastructure; role *privilege* is schema, so the GRANT
   and REVOKE statements stay in the migration where T019 puts them. Task 6 proves the binding
   with a test asserting `UPDATE` on the ledger raises SQLSTATE `42501`.

4. **`test:unit` is repointed to a path, not given Jest projects.** Changing it to
   `jest test/unit` is a one-token fix; introducing a `projects` array would restructure the whole
   Jest config and change how `--coverage` aggregates, which is not this phase's business.

5. **`advancePosition` is pure and synchronous.** It takes the current program state plus the
   entries to append and returns a new program state plus the entries actually written (including
   any over-limit marker it emitted). It performs no I/O and imports nothing from TypeORM. The
   repository in Task 9 is what persists its result. This is what lets Task 8's tests be plain
   unit tests and what keeps `boundaries` satisfied.

6. **Immutability throughout.** Per the project coding-style rule, `advancePosition` returns a new
   program object; it never mutates its argument. Task 8's tests assert the input object is
   unchanged.

7. **Money conversion returns a `Result`, never throws, for expected refusals.** A conversion
   landing on zero minor units returns `AmountRoundsToZero`. A currency mismatch in *arithmetic*
   (adding EUR to USD) is a programming error and does throw. The distinction: refusals the caller
   is expected to handle are values; invariant violations are exceptions.

## Execution Order

### Task 1: Land the eslint-plugin-boundaries v7 selector migration

#### Objective

Replace every deprecated bare element-type string in `eslint.config.mjs` with the v7 object
selector form, and prove by executable probe that the boundary matrix still enforces exactly what
it enforced before.

#### Files
- `eslint.config.mjs` — modify the ten `allow:` arrays.
- `scripts/verify-uat.sh` — already contains a probe-based boundary check from Phase 1; confirm it
  still passes. Do not rewrite it.

#### Implementation

1. In `eslint.config.mjs`, inside `rules['boundaries/dependencies'][1].policies`, rewrite each
   entry so that every bare string in `allow:` becomes `{ to: [{ type: '<string>' }] }`. The
   resulting block must read exactly:

```js
          policies: [
            { from: 'domain', allow: [{ to: [{ type: 'domain' }] }, { to: [{ type: 'shared' }] }] },
            { from: 'application', allow: [{ to: [{ type: 'domain' }] }, { to: [{ type: 'infrastructure' }] }, { to: [{ type: 'shared' }] }, { to: [{ type: 'fx' }] }, { to: [{ type: 'config' }] }] },
            { from: 'infrastructure', allow: [{ to: [{ type: 'domain' }] }, { to: [{ type: 'shared' }] }, { to: [{ type: 'config' }] }] },
            { from: 'api', allow: [{ to: [{ type: 'application' }] }, { to: [{ type: 'domain' }] }, { to: [{ type: 'shared' }] }] },
            { from: 'treasury', allow: [{ to: [{ type: 'application' }] }, { to: [{ type: 'shared' }] }, { to: [{ type: 'config' }] }, { to: [{ type: 'observability' }] }] },
            { from: 'fx', allow: [{ to: [{ type: 'domain' }] }, { to: [{ type: 'shared' }] }, { to: [{ type: 'config' }] }] },
            { from: 'auth', allow: [{ to: [{ type: 'shared' }] }, { to: [{ type: 'config' }] }] },
            { from: 'shared', allow: [{ to: [{ type: 'shared' }] }, { to: [{ type: 'config' }] }] },
            { from: 'config', allow: [{ to: [{ type: 'shared' }] }, { to: [{ type: 'config' }] }] },
            { from: 'observability', allow: [{ to: [{ type: 'shared' }] }, { to: [{ type: 'config' }] }] },
          ],
```

2. Change nothing else in the file — not `settings`, not `boundaries/elements`, not `ignores`.

#### Constraints
- Do not alter which dependencies are permitted. This is a syntax migration and nothing else.
- Do not add or remove element types.
- Do not touch `boundaries/no-unknown-files`.

#### Edge Cases
- `boundaries` only evaluates a file when it matches a `boundaries/elements` pattern. `src/` today
  contains no matching file, so a clean lint run alone proves nothing. The probe in
  `scripts/verify-uat.sh` is what establishes the matrix is live — rely on it, not on lint output.

#### Verification

```bash
npm run lint 2>&1 | grep -i "deprecat" ; echo "grep-exit=$?"
grep -c "element-types" eslint.config.mjs
./scripts/verify-uat.sh ; echo "uat=$?"
```

Expected:
- The grep for `deprecat` finds nothing (`grep-exit=1`).
- `grep -c element-types` prints `0`.
- `uat=0`.

#### Completion Criteria
- [ ] Every `allow:` entry uses the `{ to: [{ type: 'x' }] }` form.
- [ ] `npm run lint` exits 0 and emits zero deprecation warnings.
- [ ] `./scripts/verify-uat.sh` exits 0.

---

### Task 2: Implement the Money value object and FX conversion (T009–T012)

#### Objective

A `Money` type in `bigint` minor units with an ISO-4217 code that makes floating point
unrepresentable, plus half-up rounding and currency conversion done entirely in integer
arithmetic.

#### Files
- `test/unit/money.spec.ts` — create. Tests for construction and arithmetic.
- `src/shared/money/money.ts` — create. The value object.
- `test/unit/rounding.spec.ts` — create. Tests for rounding and conversion.
- `src/shared/money/convert.ts` — create. Rounding and conversion.
- `src/shared/money/index.ts` — create. Re-exports both modules.

#### Implementation

Write the tests first and watch them fail before writing the implementation (Constitution VI).

**`src/shared/money/money.ts`** exports:

```ts
export type CurrencyCode = string & { readonly __brand: 'CurrencyCode' };

export interface Money {
  readonly minor: bigint;
  readonly currency: CurrencyCode;
}

export function currency(code: string): CurrencyCode;
export function money(minor: bigint, code: string | CurrencyCode): Money;
export function add(a: Money, b: Money): Money;
export function subtract(a: Money, b: Money): Money;
export function negate(a: Money): Money;
export function isZero(a: Money): boolean;
export function compare(a: Money, b: Money): -1 | 0 | 1;
export function toDecimalString(a: Money, minorUnitDigits: number): string;
export function fromDecimalString(value: string, code: string, minorUnitDigits: number): Money;
export class CurrencyMismatchError extends Error {}
```

Rules:
- `currency(code)` throws `TypeError` unless `code` matches `/^[A-Z]{3}$/`.
- `money(minor, code)` accepts `bigint` only. If `typeof minor === 'number'` it throws `TypeError`
  with message `money() requires bigint minor units, received number`. The public signature does
  not admit `number`; the runtime check exists because callers may be untyped JavaScript.
- `add`, `subtract`, `compare` throw `CurrencyMismatchError` when `a.currency !== b.currency`.
- All functions return new objects. Nothing mutates its arguments.
- `toDecimalString` renders minor units as a decimal string with exactly `minorUnitDigits`
  fractional digits, handling negatives (`-1n` with 2 digits → `"-0.01"`). This is the wire form:
  money crosses HTTP as a decimal **string**, bounded to 19 significant digits.
- `fromDecimalString` is its inverse and rejects any input with more fractional digits than
  `minorUnitDigits`, more than 19 significant digits, or not matching
  `/^-?\d{1,19}(\.\d+)?$/`, by throwing `TypeError`.

**`src/shared/money/convert.ts`** exports:

```ts
export const RATE_SCALE = 10n ** 10n;   // NUMERIC(20,10) — ten fractional digits

export function scaleRate(rate: string): bigint;
export function roundHalfUp(numerator: bigint, denominator: bigint): bigint;

export type ConversionOutcome =
  | { readonly kind: 'converted'; readonly amount: Money }
  | { readonly kind: 'roundsToZero' };

export function convert(
  amount: Money,
  targetCurrency: string,
  scaledRate: bigint,
): ConversionOutcome;
```

Rules:
- `scaleRate('1.0850000000')` returns `10850000000n`. It parses the decimal string with string
  operations and `BigInt`; it never calls `Number` or `parseFloat`. It throws `TypeError` if the
  string has more than ten fractional digits or does not match `/^\d{1,10}(\.\d{1,10})?$/`, and
  throws if the resulting value is `0n` (a zero rate is not a rate).
- `roundHalfUp(n, d)` requires `d > 0n`. It computes `n / d` rounded half away from zero, using
  only `bigint`: compute `q = n / d` and `r = n % d`; if `2n * abs(r) >= d`, adjust `q` by one in
  the sign direction of `n`.
- `convert(amount, target, scaledRate)` computes
  `roundHalfUp(amount.minor * scaledRate, RATE_SCALE)`. If the result is `0n` **and**
  `amount.minor !== 0n`, it returns `{ kind: 'roundsToZero' }`. Otherwise it returns
  `{ kind: 'converted', amount: money(result, target) }`.
- `convert` never throws for a rounding outcome. `AmountRoundsToZero` is a value, per
  `contracts/errors.md`.

**Required test cases, `test/unit/money.spec.ts`:**
- `money(100 as any, 'USD')` throws `TypeError` — construction from `number` is rejected.
- `currency('usd')`, `currency('US')`, `currency('USDD')`, `currency('US1')` each throw.
- `add(money(1n,'USD'), money(1n,'EUR'))` throws `CurrencyMismatchError`.
- `9007199254740993n` (one above `Number.MAX_SAFE_INTEGER`) survives
  `fromDecimalString(toDecimalString(m, 2), 'USD', 2)` unchanged — the round trip that a `number`
  implementation silently corrupts.
- `toDecimalString(money(-1n, 'USD'), 2)` === `'-0.01'`.
- `toDecimalString(money(0n, 'USD'), 2)` === `'0.00'`.
- `fromDecimalString('1.234', 'USD', 2)` throws.
- `add` returns a new object and leaves both operands unchanged (assert with `toEqual` on
  pre-captured copies).

**Required test cases, `test/unit/rounding.spec.ts`:**
- `roundHalfUp(5n, 10n)` === `1n` and `roundHalfUp(-5n, 10n)` === `-1n` — half away from zero, both
  signs.
- `roundHalfUp(4n, 10n)` === `0n`; `roundHalfUp(15n, 10n)` === `2n`.
- `scaleRate('1.0850000000')` === `10850000000n`; `scaleRate('1.085')` === `10850000000n`.
- `scaleRate('0')` throws; `scaleRate('1.08500000001')` throws.
- **The 1 JPY → USD case**: `convert(money(1n, 'JPY'), 'USD', scaleRate('0.0067'))` returns
  `{ kind: 'roundsToZero' }`. (1 × 0.0067 = 0.0067 minor units, rounds to 0.)
- `convert(money(0n, 'JPY'), 'USD', scaleRate('0.0067'))` returns `kind: 'converted'` with `0n` —
  a genuine zero is not a rounding failure.
- `convert(money(1_000_000_00n, 'EUR'), 'USD', scaleRate('1.0850000000'))` returns `108500000n`.

#### Constraints
- `src/shared/**` may import only from `shared` and `config` (the boundaries matrix). Import
  nothing else.
- Do not add a decimal library. Constitution I mandates integer minor units; `bigint` is the
  whole mechanism.
- Do not use `Number`, `parseFloat`, `Math.round` or floating-point literals anywhere in either
  file.

#### Edge Cases
- Negative amounts: releases append negative deltas, so `roundHalfUp` must be correct for negative
  numerators. Tested above.
- `amount.minor === 0n`: converting zero is legal and yields zero; it is not `roundsToZero`.
- `scaledRate` of exactly `RATE_SCALE` (rate 1.0) must be an exact identity for any input.

#### Verification

```bash
npx jest test/unit/money.spec.ts test/unit/rounding.spec.ts
npm run typecheck
npm run lint
```

Expected: all three exit 0, with every test above present and passing.

#### Completion Criteria
- [ ] `src/shared/money/money.ts` and `convert.ts` exist and export the signatures above.
- [ ] Both spec files exist with every listed case.
- [ ] `grep -nE "\bNumber\(|parseFloat|Math\.round" src/shared/money/` returns nothing.
- [ ] `npx jest test/unit/money.spec.ts test/unit/rounding.spec.ts` exits 0.
- [ ] `npm run typecheck` and `npm run lint` exit 0.

---

### Task 3: Implement the Result type and correlation-id propagation (T013, T014)

#### Objective

A typed `Result` so expected refusals are return values rather than exceptions, and a correlation
id that propagates from both HTTP and Kafka and is treated as untrusted data.

#### Files
- `src/shared/result/result.ts` — create.
- `src/shared/result/index.ts` — create, re-exports.
- `test/unit/result.spec.ts` — create.
- `src/shared/correlation/correlation.ts` — create. Pure helpers.
- `src/shared/correlation/correlation.middleware.ts` — create. The HTTP side.
- `src/shared/correlation/index.ts` — create, re-exports.
- `test/unit/correlation.spec.ts` — create.

#### Implementation

**`src/shared/result/result.ts`:**

```ts
export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T>;
export function err<E>(error: E): Err<E>;
export function isOk<T, E>(r: Result<T, E>): r is Ok<T>;
export function isErr<T, E>(r: Result<T, E>): r is Err<E>;
export function map<T, U, E>(r: Result<T, E>, f: (t: T) => U): Result<U, E>;
export function mapErr<T, E, F>(r: Result<T, E>, f: (e: E) => F): Result<T, F>;
export function unwrapOr<T, E>(r: Result<T, E>, fallback: T): T;
```

`ok` and `err` return frozen objects (`Object.freeze`). There is no `unwrap()` that throws — the
point of the type is that callers must branch.

**`src/shared/correlation/correlation.ts`:**

```ts
export const CORRELATION_HEADER = 'x-correlation-id';
export const MAX_CORRELATION_LENGTH = 128;

export function sanitiseCorrelationId(raw: unknown): string | null;
export function resolveCorrelationId(raw: unknown): string;
```

- `sanitiseCorrelationId` returns `null` unless `raw` is a string of length 1..128 matching
  `/^[A-Za-z0-9._:-]+$/`. Anything else — array (repeated header), object, number, empty string,
  over-length, or a value containing `%`, `{`, `}`, `\n`, `\r`, a quote or a space — yields `null`.
- `resolveCorrelationId` returns the sanitised value, or a fresh `randomUUID()` when it is `null`.
- Neither function ever interpolates the value into a template used as a log format string or a
  SQL fragment. The value is carried as a discrete field only.

**`src/shared/correlation/correlation.middleware.ts`** exports a NestJS middleware class
`CorrelationMiddleware implements NestMiddleware` that reads `req.headers[CORRELATION_HEADER]`,
calls `resolveCorrelationId`, assigns it to `req.correlationId`, and sets the same value on the
response header `x-correlation-id` so a caller can correlate its own request. It also provides a
module-level `AsyncLocalStorage<{ correlationId: string }>` instance exported as
`correlationStore`, entered with `correlationStore.run(...)` around `next()`, plus
`export function currentCorrelationId(): string | undefined`.

Also export `correlationFromKafkaHeaders(headers: Record<string, Buffer | string | undefined>):
string` which reads the `x-correlation-id` header, decodes a `Buffer` as UTF-8, and passes it
through `resolveCorrelationId`. It lives in `correlation.ts` (not the middleware file) so that
`src/treasury/**` can use it in a later phase without importing HTTP types.

**Required test cases, `test/unit/result.spec.ts`:**
- `isOk(ok(1))` true, `isErr(ok(1))` false, and the mirror.
- `map` applies to `Ok` and passes `Err` through untouched.
- `mapErr` applies to `Err` and passes `Ok` through untouched.
- `ok(1)` is frozen: assigning `.value` throws in strict mode.

**Required test cases, `test/unit/correlation.spec.ts`:**
- A valid id round-trips unchanged.
- A 129-character id yields `null` from `sanitiseCorrelationId`, and `resolveCorrelationId`
  returns a UUID instead.
- An array value (`['a','b']`, the repeated-header shape) yields `null`.
- `'%s%s%s'` yields `null` — the format-string injection case.
- `"a' OR 1=1"` yields `null`.
- `''`, `undefined`, `null`, `42`, `{}` each yield `null`.
- `resolveCorrelationId(undefined)` returns a string matching the UUID v4 pattern.
- `correlationFromKafkaHeaders({ 'x-correlation-id': Buffer.from('abc-123') })` returns
  `'abc-123'`.

#### Constraints
- `src/shared/**` may import only `shared` and `config`. `correlation.middleware.ts` imports
  `@nestjs/common` and `express` types, which are not `boundaries` elements and are therefore
  unconstrained — but do not import anything from `capacity/`, `treasury/` or `auth/`.
- Do not register the middleware yet. Task 12 wires it in `app.module.ts`.

#### Edge Cases
- Express lower-cases incoming header names; still read via the lower-case constant.
- A repeated `x-correlation-id` header arrives as an array. It must be rejected, not joined — a
  caller sending two values has no single correlation id.

#### Verification

```bash
npx jest test/unit/result.spec.ts test/unit/correlation.spec.ts
npm run typecheck
npm run lint
```

Expected: all exit 0.

#### Completion Criteria
- [ ] All seven files exist.
- [ ] Every listed test case is present and passing.
- [ ] `npm run typecheck` and `npm run lint` exit 0.

---

### Task 4: Add the infrastructure prerequisites the schema work depends on

#### Objective

Create the TypeORM data source, add Redis to the local stack, install the two new dependencies,
extend the env schema, add the Postgres role bootstrap, and fix the broken `test:unit` script.

#### Files
- `package.json` — add two dependencies; fix the `test:unit` script; add three scripts.
- `package-lock.json` — regenerated by `npm install`.
- `src/config/data-source.ts` — create. Referenced by the existing `migration:run` script.
- `src/config/env.schema.ts` — modify. Add `REDIS_URL`.
- `.env.example` — modify. Add `REDIS_URL`.
- `docker-compose.yml` — modify. Add the `redis` service; mount the Postgres init script.
- `docker/postgres-init.sql` — create. Bootstraps `app_role` and `capacity_app`.

#### Implementation

1. Install, pinned exactly (caret-free, matching the Phase 1 convention):

```bash
npm install --save-exact ioredis@5.11.1 @nest-lab/throttler-storage-redis@1.2.0
```

   `ioredis` is pinned to 5.11.1 rather than the newer 6.0.0 — see Key Decision 2.

2. In `package.json` `scripts`, change `"test:unit"` from `"jest --selectProjects unit"` to
   `"jest test/unit"`. Add:
   - `"migration:revert": "typeorm-ts-node-commonjs migration:revert -d src/config/data-source.ts"`
   - `"migration:generate": "typeorm-ts-node-commonjs migration:generate -d src/config/data-source.ts"`
   - `"seed": "ts-node scripts/seed.ts"`

3. Create `src/config/data-source.ts`:

```ts
import 'reflect-metadata';
import { DataSource } from 'typeorm';

export const dataSourceOptions = {
  type: 'postgres' as const,
  url: process.env.DATABASE_URL,
  entities: ['src/capacity/infrastructure/entities/*.entity.ts'],
  migrations: ['src/migrations/*.ts'],
  migrationsTableName: 'typeorm_migrations',
  synchronize: false,
  logging: false,
};

export default new DataSource(dataSourceOptions);
```

   `synchronize` is `false` permanently — Constitution forbids hand-edited schema, and schema
   changes ship as migrations.

4. In `src/config/env.schema.ts`, add inside the `Joi.object({...})`:

```ts
  REDIS_URL: Joi.string().uri({ scheme: ['redis', 'rediss'] }).required(),
```

   Add the matching line to `.env.example`: `REDIS_URL=redis://localhost:6379`. Do not put any
   real credential in `.env.example`.

5. In `docker-compose.yml`, add a service:

```yaml
  redis:
    image: redis:7.4.11-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 10
```

   and, on the existing `postgres` service, add to its `volumes:` list:

```yaml
      - ./docker/postgres-init.sql:/docker-entrypoint-initdb.d/10-roles.sql:ro
```

   Leave the existing `pgdata` volume entry in place.

6. Create `docker/postgres-init.sql`:

```sql
-- Runs once, on first initialisation of an empty data directory.
-- Establishes the non-owner identity the application connects as, so that the
-- REVOKE on capacity_ledger_entry in the migration actually binds. A table's
-- owner keeps every privilege regardless of REVOKE, so the application must not
-- be the owner.
CREATE ROLE app_role NOLOGIN;
CREATE ROLE capacity_app LOGIN PASSWORD 'capacity_local_dev' IN ROLE app_role;
GRANT CONNECT ON DATABASE capacity TO app_role;
GRANT USAGE ON SCHEMA public TO app_role;
```

   The password here is a local-development value in a file that is committed; it matches the
   existing `capacity_local_dev` convention already present in `docker-compose.yml` for the local
   stack and is never used outside it. Real deployments supply `DATABASE_URL` from the
   environment.

#### Constraints
- Do not change the Postgres image tag, the Redpanda service, or the topic bootstrapper.
- Do not add any dependency beyond the two named.
- Do not set `synchronize: true` under any circumstance.
- Do not put a real secret in `.env.example` or `docker/postgres-init.sql`.
- Do not modify `jest.config.ts` — in particular, do not lower `coverageThreshold`.

#### Edge Cases
- `/docker-entrypoint-initdb.d` scripts run **only** when the data directory is empty. A developer
  with an existing `pgdata` volume will not get the roles. Note this in the file's header comment
  and state the recovery in the verification step below (`docker compose down -v`).
- `data-source.ts` uses `.ts` glob paths, correct for `typeorm-ts-node-commonjs`. The runtime
  application configures TypeORM separately through `@nestjs/typeorm`; this data source exists for
  the migration CLI.

#### Verification

```bash
npm run typecheck
npm run lint
node -e "const p=require('./package.json'); if(p.scripts['test:unit']!=='jest test/unit') process.exit(1); if(!p.dependencies.ioredis) process.exit(1); console.log('ok')"
docker compose down -v
docker compose up -d
docker compose ps
docker compose exec -T postgres psql -U capacity -d capacity -c "\du" | grep -E "app_role|capacity_app"
docker compose exec -T redis redis-cli ping
```

Expected:
- `typecheck` and `lint` exit 0; the node check prints `ok`.
- `docker compose ps` shows `postgres`, `redis` and `redpanda` healthy.
- The `\du` output lists both `app_role` and `capacity_app`.
- `redis-cli ping` prints `PONG`.

#### Completion Criteria
- [ ] `ioredis@5.11.1` and `@nest-lab/throttler-storage-redis@1.2.0` appear in `dependencies` with
      exact versions and no caret.
- [ ] `src/config/data-source.ts` exists and `synchronize` is `false`.
- [ ] `REDIS_URL` is required in `env.schema.ts` and present in `.env.example`.
- [ ] `docker compose up -d` brings all four services up healthy from a clean `down -v`.
- [ ] `app_role` and `capacity_app` both exist in the database.

---

### Task 5: Write the initial schema migration (T015–T020)

#### Objective

One reversible TypeORM migration creating every table, enum, check constraint, the limit trigger,
the ledger privilege grants, and every index from `data-model.md`.

#### Files
- `src/migrations/1758240000000-InitialSchema.ts` — create. The `1758240000000` prefix is the
  literal filename to use; do not substitute a generated timestamp, so that later tasks in this
  plan can name the file unambiguously.

#### Implementation

Implement `MigrationInterface` with `up(queryRunner)` and `down(queryRunner)`. Use
`queryRunner.query(...)` with literal SQL — do not use the schema-builder API, because several
constructs below (the `WHEN` trigger clause, the partial index, the `REVOKE`) are not expressible
through it.

**`up()`, in this exact order:**

1. `CREATE EXTENSION IF NOT EXISTS pgcrypto;` — for `gen_random_uuid()`.

2. Create the seven enum types, with exactly these labels and no others:
   - `reservation_status`: `ACTIVE`, `PARTIALLY_RELEASED`, `FULLY_RELEASED`, `CANCELLED`, `WRITTEN_OFF`
   - `reservation_origin`: `LOCAL`, `TREASURY`
   - `position_component`: `LOCAL`, `TREASURY`, `LIMIT`
   - `ledger_cause`: `RESERVATION`, `RELEASE`, `CANCELLATION`, `WRITE_OFF`, `TREASURY_EVENT`, `LIMIT_CHANGE`, `RECONCILIATION_ADJUSTMENT`, `OVER_LIMIT_ONSET`, `OVER_LIMIT_CLEARED`
   - `request_state`: `PENDING`, `COMPLETE`
   - `message_kind`: `EVENT`, `SNAPSHOT`
   - `ack_kind`: `EXPLICIT`, `WATERMARK`

3. `organisation` — `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`, `name TEXT NOT NULL`,
   `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`.

4. `program` — every column from `data-model.md`'s table, verbatim, with these constraints:

```sql
CHECK (local_reserved_minor >= 0)
CHECK (treasury_reserved_minor >= 0)
CHECK (credit_limit_minor >= 0)
CHECK (currency ~ '^[A-Z]{3}$')
```

   and **no** `CHECK (local_reserved_minor <= credit_limit_minor)`. Defaults: `credit_limit_minor`,
   `local_reserved_minor`, `treasury_reserved_minor` default `0`; `next_sequence` defaults `1`;
   `treasury_version` defaults `0`; `investigation_required` defaults `FALSE`;
   `position_verified` defaults `TRUE`; `position_changed_at` defaults `now()`.
   `organisation_id` is `NOT NULL REFERENCES organisation(id)`.

5. `invoice_reservation` — every column verbatim, with:

```sql
UNIQUE (program_id, invoice_id)
CHECK (invoice_amount_minor > 0 AND reserved_minor > 0)
CHECK (outstanding_invoice_minor BETWEEN 0 AND invoice_amount_minor)
CHECK (outstanding_reserved_minor BETWEEN 0 AND reserved_minor)
CHECK ((invoice_currency = program_currency) = (fx_rate IS NULL))
CHECK (fx_rate IS NULL OR fx_rate > 0)
CHECK (treasury_acknowledged = (acknowledged_by_version IS NOT NULL))
```

   `program_id` is `NOT NULL REFERENCES program(id) ON DELETE RESTRICT`. `fx_rate` is
   `NUMERIC(20,10) NULL`. `program_currency` is present and `NOT NULL` — the denormalisation is
   what makes the FX check expressible; do not omit it.

6. `capacity_ledger_entry` — columns verbatim, `UNIQUE (program_id, sequence)`, `program_id
   NOT NULL REFERENCES program(id) ON DELETE RESTRICT`. **No partitioning** — see `data-model.md`
   and research R8; `PARTITION BY RANGE (occurred_at)` cannot coexist with
   `UNIQUE (program_id, sequence)`.

7. `request_record` — `PRIMARY KEY (organisation_id, request_id)`, **composite, never
   `request_id` alone** (FR-006d), plus
   `CHECK ((state = 'COMPLETE') = (outcome IS NOT NULL))`.

8. `processed_message`, `stream_position`, `program_stream_position`, `snapshot_acknowledgement`,
   `fx_rate` — each exactly as tabulated in `data-model.md`, including:
   - `stream_position` PK `(topic, partition)`; note `offset` is a reserved word, so quote it as
     `"offset"` in every statement.
   - `program_stream_position` PK `(program_id, topic, partition)`.
   - `snapshot_acknowledgement` PK `message_id`, FK to `processed_message(message_id)`, plus
     `CHECK ((kind = 'EXPLICIT') = (reservation_references IS NOT NULL))` and
     `CHECK ((kind = 'WATERMARK') = (ingested_through IS NOT NULL))`.
   - `fx_rate` PK `(base_currency, quote_currency, effective_at)` with `effective_at` ordered
     **last**, so the PK index serves the
     `WHERE base=? AND quote=? AND effective_at <= now() ORDER BY effective_at DESC LIMIT 1` probe.

9. The limit trigger, exactly:

```sql
CREATE FUNCTION assert_local_within_limit() RETURNS trigger AS $$
BEGIN
  IF NEW.local_reserved_minor > NEW.credit_limit_minor THEN
    RAISE EXCEPTION 'local reserved %:% exceeds credit limit %',
      NEW.id, NEW.local_reserved_minor, NEW.credit_limit_minor
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER program_local_within_limit
  BEFORE UPDATE ON program FOR EACH ROW
  WHEN (NEW.local_reserved_minor > OLD.local_reserved_minor)
  EXECUTE FUNCTION assert_local_within_limit();
```

   **The `WHEN` clause is the whole point.** Without it the trigger fires on a treasury-asserted
   limit reduction and aborts it, which Constitution III v2.1.0 explicitly forbids — the limit
   falling below existing reservations is an over-limit condition to be marked, never a write to
   be rejected. Do not "simplify" it to a table `CHECK`.

10. Privileges:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_role;
REVOKE UPDATE, DELETE ON capacity_ledger_entry FROM app_role;
```

   in that order — the blanket grant first, then the targeted revoke, or the revoke is undone.

11. Every index from `data-model.md`, named explicitly so `down()` can drop them:

```sql
CREATE INDEX idx_program_organisation ON program (organisation_id);
CREATE INDEX idx_reservation_program_status ON invoice_reservation (program_id, status, created_at DESC);
CREATE INDEX idx_reservation_unacked ON invoice_reservation (program_id) WHERE origin = 'LOCAL' AND NOT treasury_acknowledged;
CREATE INDEX idx_reservation_treasury_ref ON invoice_reservation (program_id, treasury_reference);
CREATE INDEX idx_ledger_program_sequence ON capacity_ledger_entry (program_id, sequence DESC);
CREATE INDEX idx_ledger_program_cause_sequence ON capacity_ledger_entry (program_id, cause, sequence DESC);
CREATE INDEX idx_request_recorded_at ON request_record (recorded_at);
CREATE INDEX idx_processed_message_processed_at ON processed_message (processed_at);
```

**`down()`** reverses everything in exact inverse order: drop indexes, revoke nothing (grants die
with the tables), drop the trigger then the function, drop tables in FK-dependency order
(`snapshot_acknowledgement`, `program_stream_position`, `stream_position`, `processed_message`,
`request_record`, `capacity_ledger_entry`, `invoice_reservation`, `fx_rate`, `program`,
`organisation`), then drop the seven enum types. Do **not** drop the `pgcrypto` extension —
another database object may depend on it.

#### Constraints
- Do not add a `CHECK` binding `local_reserved_minor` to `credit_limit_minor`. It must be the
  trigger, with the `WHEN` clause.
- Do not partition `capacity_ledger_entry`.
- Do not make `request_record`'s primary key `request_id` alone.
- Do not use TypeORM's `synchronize` or schema-builder helpers.
- Do not create `app_role` inside the migration — Task 4's init script owns role existence.

#### Edge Cases
- `offset` is a reserved SQL word; it must be double-quoted everywhere it appears.
- `GRANT ... ON ALL TABLES` binds only tables existing at the moment it runs, which is why step 10
  comes after every `CREATE TABLE`.
- If `app_role` does not exist the `GRANT` fails loudly. That is correct: it means Task 4's init
  script did not run, and silently skipping would leave the append-only guarantee unenforced.

#### Verification

```bash
docker compose up -d postgres
npm run migration:run
docker compose exec -T postgres psql -U capacity -d capacity -c "\dt"
docker compose exec -T postgres psql -U capacity -d capacity -c "SELECT tgname, pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname = 'program_local_within_limit';"
npm run migration:revert
npm run migration:run
```

Expected:
- `\dt` lists all ten tables.
- The trigger definition output contains `WHEN ((new.local_reserved_minor > old.local_reserved_minor))`.
- Revert then re-run both succeed with no error.

#### Completion Criteria
- [ ] `src/migrations/1758240000000-InitialSchema.ts` exists with both `up` and `down`.
- [ ] All ten tables, seven enums, every listed `CHECK`, the trigger with its `WHEN` clause, the
      three privilege statements and all eight indexes are present.
- [ ] `migration:run` → `migration:revert` → `migration:run` all succeed.
- [ ] `grep -c "PRIMARY KEY (organisation_id, request_id)" src/migrations/*.ts` returns at least 1.

---

### Task 6: Prove the migration reverses and the ledger is append-only (T021)

#### Objective

An integration test against a real Postgres that applies `up`, `down`, `up` cleanly — the
Constitution merge gate that had no artifact — and a test proving the ledger `REVOKE` actually
binds the application role.

#### Files
- `test/migration/migration.spec.ts` — create.
- `test/support/postgres-container.ts` — create. Shared Testcontainers helper.
- `jest.config.ts` — modify `testRegex` only if `test/migration` is not already matched.

#### Implementation

1. `test/support/postgres-container.ts` exports
   `startPostgres(): Promise<{ container, ownerUrl, appUrl, stop }>`. It starts
   `PostgreSqlContainer` on image `postgres:16.10-alpine` with database `capacity`, user
   `capacity`, password `capacity_local_dev`, and after start executes the contents of
   `docker/postgres-init.sql` against it so the container matches the compose stack.
   `appUrl` is the same connection string with user `capacity_app`. Set a 120-second startup
   timeout.

2. `test/migration/migration.spec.ts`, with `jest.setTimeout(180_000)`:

   - **`up → down → up` applies cleanly.** Build a `DataSource` from `dataSourceOptions` with the
     container's `ownerUrl`. Call `runMigrations()`, then `undoLastMigration()`, then
     `runMigrations()` again. Assert no throw. After the `down`, assert
     `SELECT to_regclass('public.program')` is `null` — the revert really dropped the schema, not
     merely recorded that it did.
   - **The trigger permits a limit reduction below current reservations.** Insert an organisation
     and a program with `credit_limit_minor = 1000`, `local_reserved_minor = 0`. `UPDATE` it to
     `local_reserved_minor = 800`. Then `UPDATE` it to `credit_limit_minor = 500`, leaving local
     at 800. **Assert this succeeds** — this is FR-011c and the reason the trigger has a `WHEN`
     clause. A plain `CHECK` would abort here.
   - **The trigger refuses a local increase past the limit.** On the same program, `UPDATE` to
     `local_reserved_minor = 900` and assert it raises with SQLSTATE `23514`.
   - **The ledger is append-only for the application role.** Connect a second `DataSource` as
     `capacity_app`. `INSERT` a `capacity_ledger_entry` row — assert it succeeds. Then
     `UPDATE capacity_ledger_entry SET delta_minor = 1` — assert it raises SQLSTATE `42501`
     (`insufficient_privilege`). Then `DELETE FROM capacity_ledger_entry` — assert `42501` too.
   - **`request_record`'s key is composite.** Insert two rows with the same `request_id` under two
     different `organisation_id` values. Assert both succeed. Then insert a duplicate of one of
     them and assert SQLSTATE `23505`. A single-column key would have failed the first assertion.
   - **The FX check binds both directions.** Insert an `invoice_reservation` with
     `invoice_currency = program_currency` and a non-null `fx_rate` — assert `23514`. Insert one
     with differing currencies and a null `fx_rate` — assert `23514`.

3. Confirm `jest.config.ts`'s `roots` includes `<rootDir>/test` (it does) and `testRegex`
   `.*\.spec\.ts$` matches `test/migration/migration.spec.ts` (it does). No change should be
   needed; make none if so.

#### Constraints
- Use Testcontainers, not the compose stack — the test must pass on a clean machine with no
  `docker compose up` already run.
- Do not weaken any assertion to make a test pass. If the `42501` assertion fails, the `REVOKE` is
  not binding, and the fix belongs in Task 4 or Task 5, not in the test.
- Do not lower `coverageThreshold`.

#### Edge Cases
- Testcontainers image pull on a cold machine can exceed the default Jest 5-second timeout;
  `jest.setTimeout(180_000)` and the container's own 120-second startup timeout cover this.
- The owner (`capacity`) bypasses the `REVOKE`. The append-only assertions **must** use the
  `capacity_app` connection, or they will fail for the wrong reason and tempt a spurious fix.

#### Verification

```bash
npx jest test/migration/migration.spec.ts
```

Expected: exit 0, with all six described cases passing.

#### Completion Criteria
- [ ] `test/migration/migration.spec.ts` and `test/support/postgres-container.ts` exist.
- [ ] All six cases above are present and passing.
- [ ] The append-only cases connect as `capacity_app`, not `capacity`.

---

### Task 7: Create the TypeORM entities (T022)

#### Objective

Entity classes mapping every column of every table, with `bigint` columns that produce JavaScript
`bigint` and never `number`.

#### Files
- `src/capacity/infrastructure/entities/bigint.transformer.ts` — create.
- `src/capacity/infrastructure/entities/organisation.entity.ts` — create.
- `src/capacity/infrastructure/entities/program.entity.ts` — create.
- `src/capacity/infrastructure/entities/invoice-reservation.entity.ts` — create.
- `src/capacity/infrastructure/entities/capacity-ledger-entry.entity.ts` — create.
- `src/capacity/infrastructure/entities/request-record.entity.ts` — create.
- `src/capacity/infrastructure/entities/processed-message.entity.ts` — create.
- `src/capacity/infrastructure/entities/stream-position.entity.ts` — create.
- `src/capacity/infrastructure/entities/program-stream-position.entity.ts` — create.
- `src/capacity/infrastructure/entities/snapshot-acknowledgement.entity.ts` — create.
- `src/capacity/infrastructure/entities/fx-rate.entity.ts` — create.
- `src/capacity/infrastructure/entities/index.ts` — create, re-exports all entities as a named
  array `entities` plus each class.
- `test/unit/bigint-transformer.spec.ts` — create.

#### Implementation

1. `bigint.transformer.ts` exports `const bigintTransformer: ValueTransformer` where:
   - `to(value: bigint | null): string | null` returns `value === null ? null : value.toString()`.
   - `from(value: string | null): bigint | null` returns `value === null ? null : BigInt(value)`.

   The `pg` driver returns `BIGINT` as a **string** by default precisely to avoid precision loss;
   this transformer converts that string to `bigint`. It must never call `Number`.

2. Each entity declares `@Entity('<table_name>')` with the exact snake_case table name, and every
   column with an explicit `@Column({ name: '<snake_case>' , type: ..., ... })`. Every `BIGINT`
   column uses `type: 'bigint'` plus `transformer: bigintTransformer` and is typed `bigint` in
   TypeScript. Every `CHAR(3)` currency uses `type: 'char', length: 3`. `fx_rate` uses
   `type: 'numeric', precision: 20, scale: 10` and is typed `string | null` — it is a rate, not
   money, and must not go through `bigintTransformer`. Enum columns use
   `type: 'enum', enum: <TS union or enum>, enumName: '<pg enum name>'`.

3. `stream_position.offset` and `program_stream_position.offset` map to a TypeScript property
   named `offsetValue` with `@Column({ name: 'offset', type: 'bigint', transformer:
   bigintTransformer })`, because `offset` is awkward as a bare identifier and is a reserved SQL
   word.

4. `snapshot_acknowledgement.reservation_references` maps as
   `@Column({ name: 'reservation_references', type: 'text', array: true, nullable: true })`.

5. Composite primary keys use multiple `@PrimaryColumn()` decorators:
   `request_record` on `(organisationId, requestId)`; `stream_position` on `(topic, partition)`;
   `program_stream_position` on `(programId, topic, partition)`; `fx_rate` on
   `(baseCurrency, quoteCurrency, effectiveAt)`.

6. `test/unit/bigint-transformer.spec.ts` asserts:
   - `from('9007199254740993')` === `9007199254740993n` — the value that `Number` corrupts.
   - `to(9007199254740993n)` === `'9007199254740993'`.
   - `to(null)` is `null` and `from(null)` is `null`.
   - `to(-1n)` === `'-1'` and `from('-1')` === `-1n`.

#### Constraints
- `src/capacity/infrastructure/**` may import from `domain`, `shared` and `config` only. Do not
  import from `application`, `api` or `treasury`.
- No column may be typed `number` if its SQL type is `BIGINT`.
- Do not add `@ManyToOne`/`@OneToMany` relation decorators. Plain FK id columns only — relations
  invite lazy loading outside the locked transaction, which would read a position the lock does
  not cover.
- Do not use `synchronize`-driven schema. The migration in Task 5 is the only schema authority;
  entities describe it, they do not define it.

#### Edge Cases
- TypeORM's default `bigint` handling returns `string`. Omitting the transformer on any one column
  yields a silent `string` where `bigint` is expected and no type error at runtime — check every
  `BIGINT` column has it.
- `fx_rate` deliberately does **not** use the transformer. Adding it there would truncate the ten
  decimal places to an integer.

#### Verification

```bash
npx jest test/unit/bigint-transformer.spec.ts
npm run typecheck
npm run lint
grep -c "bigintTransformer" src/capacity/infrastructure/entities/*.entity.ts | grep -v ":0"
```

Expected:
- The test exits 0.
- `typecheck` and `lint` exit 0 — including `boundaries`, which is now live because these files
  match `src/capacity/infrastructure/**`.
- The grep shows the transformer referenced in every entity file that has a `BIGINT` column.

#### Completion Criteria
- [ ] All twelve files exist.
- [ ] Every `BIGINT` column uses `bigintTransformer` and is typed `bigint`.
- [ ] `fx_rate` is `numeric(20,10)` and does not use the transformer.
- [ ] `request_record` has two `@PrimaryColumn()` declarations.
- [ ] `npm run lint` exits 0 with no `boundaries` violation.

---

### Task 8: Implement advancePosition, the core position arithmetic (T023, T024)

#### Objective

The one function permitted to write the program row: it appends ledger entries, assigns gapless
sequences, advances all three component caches, re-evaluates the over-limit mark, and emits marker
entries when that mark changes.

#### Files
- `test/unit/position.spec.ts` — create. Write first; watch it fail.
- `src/capacity/domain/position.ts` — create.
- `src/capacity/domain/ledger-entry.ts` — create. The entry types.
- `src/capacity/domain/program.ts` — create. The program state type.

#### Implementation

**`src/capacity/domain/ledger-entry.ts`:**

```ts
export type PositionComponent = 'LOCAL' | 'TREASURY' | 'LIMIT';

export type LedgerCause =
  | 'RESERVATION' | 'RELEASE' | 'CANCELLATION' | 'WRITE_OFF'
  | 'TREASURY_EVENT' | 'LIMIT_CHANGE' | 'RECONCILIATION_ADJUSTMENT'
  | 'OVER_LIMIT_ONSET' | 'OVER_LIMIT_CLEARED';

/** An entry as requested by a caller, before a sequence is assigned. */
export interface PendingLedgerEntry {
  readonly deltaMinor: bigint;
  readonly component: PositionComponent;
  readonly cause: LedgerCause;
  readonly originReference: string | null;
  readonly actor: string;
  readonly correlationId: string;
}

/** An entry with its per-program sequence assigned. */
export interface SequencedLedgerEntry extends PendingLedgerEntry {
  readonly sequence: bigint;
}
```

**`src/capacity/domain/program.ts`:**

```ts
export interface ProgramPosition {
  readonly id: string;
  readonly currency: string;
  readonly creditLimitMinor: bigint;
  readonly localReservedMinor: bigint;
  readonly treasuryReservedMinor: bigint;
  readonly nextSequence: bigint;
  readonly overLimitSince: Date | null;
  readonly investigationRequired: boolean;
  readonly positionVerified: boolean;
}

export function totalReserved(p: ProgramPosition): bigint;   // local + treasury
export function available(p: ProgramPosition): bigint;       // limit - total, SIGNED, never floored
export function isOverLimit(p: ProgramPosition): boolean;    // total > limit
```

`available` is signed and must never be clamped to zero — flooring conceals the over-limit
magnitude that FR-023 exists to surface.

**`src/capacity/domain/position.ts`:**

```ts
export interface AdvanceResult {
  readonly program: ProgramPosition;             // a NEW object
  readonly entries: readonly SequencedLedgerEntry[];  // including any marker emitted
}

export function advancePosition(
  program: ProgramPosition,
  entries: readonly PendingLedgerEntry[],
  now: Date,
): AdvanceResult;
```

Algorithm, in this order:

1. Start from a working copy of the three caches and `nextSequence` taken from `program`.
2. For each entry in order: assign `sequence = nextSequence`, increment `nextSequence` by `1n`,
   and add `deltaMinor` to the cache named by `component` (`LOCAL` → `localReservedMinor`,
   `TREASURY` → `treasuryReservedMinor`, `LIMIT` → `creditLimitMinor`). Collect the sequenced
   entry.
3. Compute `wasOverLimit = program.overLimitSince !== null` and
   `nowOverLimit = (local + treasury) > limit` using the **updated** caches.
4. If `!wasOverLimit && nowOverLimit`: append one more entry, `cause: 'OVER_LIMIT_ONSET'`,
   `component: 'LIMIT'`, `deltaMinor: 0n`, `actor: 'system'`, `originReference: null`,
   `correlationId` copied from the last input entry (or `'system'` when `entries` is empty),
   assigned the next sequence. Set `overLimitSince = now`.
5. If `wasOverLimit && !nowOverLimit`: append one entry, `cause: 'OVER_LIMIT_CLEARED'`,
   otherwise identical, and set `overLimitSince = null`.
6. If neither, `overLimitSince` carries over unchanged.
7. Return a **new** `ProgramPosition` object with the updated caches, `nextSequence`, and
   `overLimitSince`. `investigationRequired` and `positionVerified` pass through untouched —
   `advancePosition` does not set them; their callers do.

`advancePosition` performs no I/O, throws nothing for ordinary inputs, and never mutates
`program` or `entries`.

**Required test cases, `test/unit/position.spec.ts`:**

- **Each component's cache equals the sum of its entries.** Apply a mixed batch — `+100n` LOCAL,
  `+50n` TREASURY, `+1000n` LIMIT, `-30n` LOCAL — to a zeroed program and assert
  `localReservedMinor === 70n`, `treasuryReservedMinor === 50n`, `creditLimitMinor === 1000n`.
- **Sequences are gapless and start from `nextSequence`.** With `nextSequence: 7n` and three
  entries, assert the assigned sequences are `7n, 8n, 9n` and the returned `nextSequence` is `10n`.
- **Immutability.** Capture a deep copy of the input program, call `advancePosition`, and assert
  the input is `toEqual` its copy and `result.program !== program`.
- **Over-limit onset.** Limit `1000n`, local `0n`. Apply `+1200n` LOCAL. Assert `overLimitSince`
  equals `now`, and that a trailing `OVER_LIMIT_ONSET` entry exists with `deltaMinor === 0n` and
  `component === 'LIMIT'`.
- **Cleared by release.** From the over-limit state above, apply `-300n` LOCAL. Assert
  `overLimitSince` is `null` and a trailing `OVER_LIMIT_CLEARED` entry exists with
  `deltaMinor === 0n` and `component === 'LIMIT'`.
- **Cleared by cancel.** Same, via a `CANCELLATION`-caused negative LOCAL entry.
- **Cleared by a limit *increase*.** From the over-limit state, apply `+500n` LIMIT with cause
  `LIMIT_CHANGE`. Assert the mark clears. This is the path a naive implementation misses, because
  nothing about the reservation changed.
- **Limit reduction causes onset.** Limit `1000n`, local `800n`, not over limit. Apply `-500n`
  LIMIT. Assert the mark is set and an `OVER_LIMIT_ONSET` entry is emitted — the limit cut is
  recorded, never rejected (FR-011c).
- **No marker when the mark does not change.** Apply `+10n` LOCAL to a program well inside its
  limit and assert `entries` has length exactly 1.
- **Still over-limit stays over-limit without a second onset.** From the over-limit state apply a
  further `+10n` LOCAL and assert no new marker entry, and `overLimitSince` unchanged from its
  original value (not reset to `now`).
- **Empty batch is a no-op.** `advancePosition(p, [], now)` returns an equal position and zero
  entries.
- **Total may exceed the limit via treasury.** Limit `1000n`, local `0n`, apply `+1500n` TREASURY.
  Assert it is accepted and the program is marked over-limit — Constitution III scopes the hard
  constraint to the consuming direction only.

#### Constraints
- `src/capacity/domain/**` may import only from `domain` and `shared`. Importing TypeORM,
  `@nestjs/*`, `pg` or `kafkajs` here is a `boundaries` error and will fail lint. This is the
  first task where that matrix actually bites — that is intentional.
- All arithmetic is `bigint`. No `number`, no `Number()`.
- Do not mutate the input program or entries array.
- Do not add persistence. Task 9 persists what this returns.
- `advancePosition` is the **only** function permitted to produce a new program position. Do not
  add a second one.

#### Edge Cases
- Entries arriving in one batch that cross the limit and then come back under it within the same
  call: the mark is evaluated once, on the final state, so no spurious onset/clear pair is
  emitted. Assert this with a batch of `+1200n` then `-300n` LOCAL against a `1000n` limit —
  expect exactly two entries and no marker.
- `entries` empty and program already over limit: no marker, mark unchanged.
- Marker entries take sequences too, so `nextSequence` accounts for them. Assert it.

#### Verification

```bash
npx jest test/unit/position.spec.ts
npm run typecheck
npm run lint
```

Expected: all exit 0. `lint` must show no `boundaries/dependencies` error.

#### Completion Criteria
- [ ] The three source files and the spec file exist.
- [ ] Every listed test case, including all three over-limit clearance paths and the
      within-batch-crossing edge case, is present and passing.
- [ ] `grep -nE "\bNumber\(|parseFloat" src/capacity/domain/` returns nothing.
- [ ] `npm run lint` exits 0.

---

### Task 9: Implement the locking unit of work and repositories (T025)

#### Objective

A transaction boundary that takes `SELECT … FOR UPDATE` on the program row at the head of every
write, at `READ COMMITTED`, and the repository that persists an `AdvanceResult` atomically.

#### Files
- `src/capacity/infrastructure/unit-of-work.ts` — create.
- `src/capacity/infrastructure/repositories/program.repository.ts` — create.
- `src/capacity/infrastructure/repositories/ledger.repository.ts` — create.
- `src/capacity/infrastructure/repositories/index.ts` — create.
- `test/integration/concurrency-lock.spec.ts` — create.

#### Implementation

1. `unit-of-work.ts` exports an injectable `UnitOfWork` with:

```ts
withProgramLock<T>(
  programId: string,
  fn: (ctx: { manager: EntityManager; program: ProgramEntity }) => Promise<T>,
): Promise<T>;
```

   It opens a transaction at isolation level `'READ COMMITTED'` via
   `dataSource.transaction('READ COMMITTED', ...)`, executes
   `SELECT * FROM program WHERE id = $1 FOR UPDATE` through the transactional manager, throws a
   typed `ProgramNotFoundError` when no row comes back, then calls `fn` with the manager and the
   locked row.

   Add this comment verbatim at the top of the file:

```ts
// Single-program locking only. Any future transaction that must lock more than one
// program MUST acquire the locks in ORDER BY id ascending. Two transactions taking
// the same pair in opposite orders deadlock, and Postgres resolves that by aborting
// one of them — which surfaces to a caller as a failure caused by contention alone,
// exactly what SC-003a forbids.
```

2. `program.repository.ts` exports an injectable `ProgramRepository` with:
   - `toPosition(entity: ProgramEntity): ProgramPosition` — maps entity to the domain type.
   - `persistAdvance(manager: EntityManager, programId: string, result: AdvanceResult, now: Date):
     Promise<void>` — within the caller's transaction, `INSERT`s every entry of
     `result.entries` into `capacity_ledger_entry` and `UPDATE`s the `program` row's
     `credit_limit_minor`, `local_reserved_minor`, `treasury_reserved_minor`, `next_sequence`,
     `over_limit_since` and `position_changed_at` from `result.program`. Both in one statement
     batch, no separate transaction.

   `persistAdvance` is the only method that writes the `program` row. Add a comment saying so.

3. `ledger.repository.ts` exports `LedgerRepository` with
   `sumByComponent(manager, programId): Promise<{ LOCAL: bigint; TREASURY: bigint; LIMIT: bigint }>`
   computing `SELECT component, COALESCE(SUM(delta_minor),0) FROM capacity_ledger_entry WHERE
   program_id = $1 GROUP BY component`, returning `0n` for absent components. This is the
   invariant check the Phase 9 reconciliation job will use; it is defined here because it reads
   the ledger and nothing else does yet.

   All queries are parameterised. No string interpolation of any value into SQL, ever.

4. `test/integration/concurrency-lock.spec.ts`, using the Task 6 Testcontainers helper:
   - **The lock serializes.** Start two `withProgramLock` calls on the same program concurrently;
     inside the first, wait until the second has certainly started, then record a timestamp;
     assert the second's body did not begin until the first committed. Implement this by having
     each body append a marker to a shared array and sleep 200ms, then assert the array reads
     `['a-start','a-end','b-start','b-end']` and never interleaves.
   - **Different programs do not block each other.** The same two-body test against two distinct
     program ids completes in well under the serialized duration and may interleave.
   - **`persistAdvance` is atomic.** Inside a `withProgramLock`, call `persistAdvance` with an
     `AdvanceResult` and then throw. Assert afterwards that neither the ledger rows nor the
     program update survive.
   - **The ledger sum invariant holds after a persisted advance.** Persist a mixed batch, then
     assert `sumByComponent` equals the program row's three cache columns exactly.
   - **`ProgramNotFoundError` for an unknown id.**

#### Constraints
- `src/capacity/infrastructure/**` may import `domain`, `shared`, `config` only.
- Isolation level is `READ COMMITTED`, not `SERIALIZABLE` — research R1 rejected `SERIALIZABLE`
  because it converts contention into retryable failures, violating SC-003a.
- The lock is a row lock on `program`, not an advisory lock.
- Every query is parameterised.
- Do not add a retry loop. The lock queues; it does not fail.

#### Edge Cases
- `FOR UPDATE` on a missing row returns zero rows rather than erroring — hence the explicit
  `ProgramNotFoundError`.
- Nested `withProgramLock` on the same id within one request would self-deadlock on the same
  connection; do not call it recursively, and do not add a re-entrancy guard (there is no caller
  that needs one yet).

#### Verification

```bash
npx jest test/integration/concurrency-lock.spec.ts
npm run typecheck
npm run lint
```

Expected: exit 0 for all three, with all five cases passing.

#### Completion Criteria
- [ ] The four source files and the spec exist.
- [ ] `withProgramLock` uses `'READ COMMITTED'` and `FOR UPDATE`.
- [ ] The multi-program lock-ordering comment is present verbatim in `unit-of-work.ts`.
- [ ] All five test cases pass.
- [ ] `npm run lint` exits 0.

---

### Task 10: Implement the authentication and program-scope guard chain (T026–T029)

#### Objective

A global HS256-only JWT guard, an ownership guard that resolves programs per request, a scope
guard, and a `@Public()` decorator — registered so ownership resolves *before* scope, which is
what makes an out-of-scope program answer 404 rather than 403.

#### Files
- `test/integration/auth.spec.ts` — create. Write first.
- `src/auth/public.decorator.ts` — create.
- `src/auth/jwt-auth.guard.ts` — create.
- `src/auth/program-scope.guard.ts` — create.
- `src/auth/scope.guard.ts` — create.
- `src/auth/required-scope.decorator.ts` — create.
- `src/auth/auth.module.ts` — create.
- `src/auth/index.ts` — create.

#### Implementation

1. `public.decorator.ts`: `export const IS_PUBLIC_KEY = 'isPublic';` and
   `export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);`

2. `required-scope.decorator.ts`: `export const REQUIRED_SCOPE_KEY = 'requiredScope';` and
   `export const RequiredScope = (scope: string) => SetMetadata(REQUIRED_SCOPE_KEY, scope);`
   Valid scopes are `capacity:read`, `capacity:write`, `capacity:audit`.

3. `jwt-auth.guard.ts`: a `CanActivate` that
   - returns `true` immediately when `IS_PUBLIC_KEY` metadata is set on the handler or class;
   - reads the `Authorization: Bearer <token>` header, refusing with `UNAUTHENTICATED` (401) when
     absent or malformed;
   - verifies with `JwtService.verifyAsync(token, { algorithms: ['HS256'], secret:
     config.JWT_SECRET, clockTolerance: config.JWT_CLOCK_SKEW_SECONDS })`.
     **`algorithms` is a single-element allow-list and the token's own `alg` and `kid` header
     fields are never read and never influence key selection** (research R7) — that is the
     algorithm-confusion and `alg: none` class, closed at design time;
   - requires `exp` to be present, rejecting a token without one;
   - requires the `org` claim to parse as a UUID (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`)
     before it is used to resolve anything;
   - parses `scope` as a space-delimited string into a `Set<string>`;
   - assigns `{ org, scopes }` to `req.auth` and returns `true`.

   Register it as a global `APP_GUARD` in `auth.module.ts`.

4. `program-scope.guard.ts`: a `CanActivate` that, when the route has a `programId` route
   parameter, queries `SELECT organisation_id FROM program WHERE id = $1` and throws
   `NotFoundException` with code `NOT_FOUND` when the program does not exist **or** its
   `organisation_id` differs from `req.auth.org`. The two cases are deliberately
   indistinguishable — that is `contracts/errors.md`'s `NOT_FOUND` row, and the reason this guard
   runs before the scope guard. Ownership is resolved from the current
   `program.organisation_id` on every request, never from a claim in the token, so a newly owned
   program becomes reachable without reissuing credentials (FR-017a).

   When the route has no `programId` parameter, return `true`.

5. `scope.guard.ts`: reads `REQUIRED_SCOPE_KEY` metadata; returns `true` when absent; otherwise
   throws `ForbiddenException` with code `INSUFFICIENT_SCOPE` unless `req.auth.scopes` contains it.

6. `auth.module.ts` registers all three as `APP_GUARD` providers **in this order**:
   `JwtAuthGuard`, then `ProgramScopeGuard`, then `ScopeGuard`. NestJS evaluates guards in
   registration order. Add this comment verbatim above the providers array:

```ts
// Order is the contract, not a preference. Ownership (ProgramScopeGuard) MUST resolve
// before scope (ScopeGuard). Reversed, a scope refusal on another organisation's program
// answers 403 where it must answer 404, and the guard chain becomes an existence oracle
// that confirms which program ids are real. See research R7 and FR-017.
```

7. `test/integration/auth.spec.ts`, booting a Nest testing module with a throwaway controller
   exposing `GET /programs/:programId/probe` (requiring `capacity:read`) and a `@Public()`
   `GET /probe/public`, against the Task 6 Testcontainers Postgres seeded with two organisations
   and one program each:
   - **A token for another organisation gets 404 before any scope check runs.** Request org B's
     program with org A's token that *also* lacks `capacity:read`. Assert **404**, not 403. If the
     guards were misordered this returns 403, so this single assertion is the whole ordering test.
   - **A correctly-owned program with the wrong scope gets 403.** Org A's token without
     `capacity:read` against org A's own program → 403, code `INSUFFICIENT_SCOPE`.
   - **A correctly-owned program with the right scope gets 200.**
   - **`alg: none` is rejected.** Hand-craft a token with header `{"alg":"none","typ":"JWT"}` and
     an empty signature → 401.
   - **An RS256-signed token is rejected.** Generate an RSA key pair, sign a structurally valid
     payload with RS256 → 401. (`@nestjs/jwt` wraps `jsonwebtoken`, already a transitive
     dependency; use `crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })` — add no new
     package.)
   - **An expired token is rejected outside the 60-second skew.** `exp` set 120 seconds in the
     past → 401. And a token expired 30 seconds ago is **accepted**, proving the tolerance is
     applied and not merely configured.
   - **A non-UUID `org` claim is rejected** → 401.
   - **A missing `Authorization` header** → 401.
   - **`/probe/public` succeeds with no token at all.**
   - **A 404 response body leaks nothing**: assert it has no `stack`, `sql` or `query` key and its
     `message` does not contain the program id of the other organisation.

8. Apply `@Public()` to nothing yet except in the test's throwaway controller — Task 12 applies it
   to the real health endpoints when it creates them.

#### Constraints
- `src/auth/**` may import `shared` and `config` only. Do not import from `capacity/`. The
  program-ownership query therefore runs through an injected `DataSource`, not through
  `ProgramRepository`.
- HS256 only. Do not accept an `algorithms` array of more than one element, and do not derive it
  from configuration.
- Do not read `kid`.
- Do not reveal in any 404 body or header whether the program exists.
- Every SQL query is parameterised.

#### Edge Cases
- A token that is well-formed and correctly signed but whose `org` names an organisation with no
  programs: any `programId` then resolves to 404, which is correct.
- The route-parameter name is exactly `programId`; a route using a different name gets no
  ownership check, which is why the guard returns `true` in that case — Phase 3 must name the
  parameter `programId`. Note this in a comment in `program-scope.guard.ts`.
- Clock skew applies in both directions; only the expiry direction is tested here because that is
  the one that admits a stale token.

#### Verification

```bash
npx jest test/integration/auth.spec.ts
npm run typecheck
npm run lint
```

Expected: exit 0, all eleven cases passing — in particular the first, which must assert 404.

#### Completion Criteria
- [ ] All eight source files exist.
- [ ] `algorithms: ['HS256']` appears and is a literal single-element array.
- [ ] The guard-ordering comment is present verbatim in `auth.module.ts`.
- [ ] All eleven test cases pass, including the 404-before-403 ordering assertion.
- [ ] `npm run lint` exits 0.

---

### Task 11: Implement per-organisation rate limiting (T030)

#### Objective

`@nestjs/throttler` backed by Redis, keyed on the token's `org` claim rather than client IP, with
separate read and write buckets, returning 429 plus `Retry-After`.

#### Files
- `src/auth/throttler.config.ts` — create.
- `src/auth/org-throttler.guard.ts` — create.
- `src/auth/auth.module.ts` — modify. Register the throttler.
- `test/integration/rate-limit.spec.ts` — create.

#### Implementation

1. `throttler.config.ts` exports a factory building `ThrottlerModuleOptions` with two named
   throttlers:
   - `{ name: 'read', ttl: 60_000, limit: config.RATE_LIMIT_READ_PER_MINUTE }`
   - `{ name: 'write', ttl: 60_000, limit: config.RATE_LIMIT_WRITE_PER_MINUTE }`

   and `storage: new ThrottlerStorageRedisService(new Redis(config.REDIS_URL))` from
   `@nest-lab/throttler-storage-redis` and `ioredis`. Both limits already exist in
   `env.schema.ts` with defaults 600 and 120.

2. `org-throttler.guard.ts` extends `ThrottlerGuard` and overrides
   `getTracker(req): Promise<string>` to return `req.auth?.org ?? req.ip`. Every caller is a
   server, so IP is near-useless as an identity; the `org` claim is the tenant boundary the limit
   must protect. The `req.ip` fallback covers unauthenticated routes (the health probes) so they
   are not unlimited.

   Override `throwThrottlingException` to throw an `HttpException` with status 429, body
   `{ code: 'RATE_LIMITED', message: 'Request budget exceeded for this organisation.',
   correlationId }`, and set the `Retry-After` response header to the bucket's remaining TTL in
   **seconds** (integer, rounded up).

3. In `auth.module.ts`, register `ThrottlerModule.forRootAsync({ useFactory: ... })` and add
   `OrgThrottlerGuard` as an `APP_GUARD` **after** `JwtAuthGuard` (so `req.auth.org` is populated
   when `getTracker` runs) and **before** `ProgramScopeGuard` (so a flooding caller is shed before
   it costs a database round trip).

4. `test/integration/rate-limit.spec.ts`, using a Testcontainers Redis
   (`GenericContainer('redis:7.4.11-alpine').withExposedPorts(6379)`) and a throwaway controller:
   - Configure `limit: 3, ttl: 60_000` for the test module.
   - Four requests with **the same** org token: the first three return 200, the fourth returns
     429 with body code `RATE_LIMITED` and a numeric `Retry-After` header greater than 0.
   - **Two different orgs have independent buckets**: exhaust org A's limit, then assert org B's
     first request still returns 200. This is the property the whole feature exists for — one
     tenant cannot deny service to another.
   - **Two different tokens for the *same* org share a bucket**: mint a second token with the same
     `org` claim and a different `jti`, and assert it is throttled. Keying on the credential
     rather than the organisation would let a tenant mint its way around the limit.
   - **The read and write buckets are separate**: exhaust the write bucket and assert a read-only
     route still succeeds.

#### Constraints
- Do not key on IP for authenticated routes.
- Do not use the default in-memory storage. Research R12 rejected it: the limit would multiply by
  replica count, which makes it not a limit.
- Do not add any dependency beyond the two installed in Task 4.
- The 429 body must carry `code: 'RATE_LIMITED'` exactly, per `contracts/errors.md`.

#### Edge Cases
- `getTracker` runs for public routes too, where `req.auth` is undefined — hence the `req.ip`
  fallback. Without it, every unauthenticated request shares one bucket keyed `undefined`.
- Redis being unreachable at boot must fail startup loudly rather than silently degrading to no
  limiting. Configure the `ioredis` client with `maxRetriesPerRequest: 3` and let the error
  propagate; do not catch and continue.

#### Verification

```bash
npx jest test/integration/rate-limit.spec.ts
npm run typecheck
npm run lint
```

Expected: exit 0, all five cases passing.

#### Completion Criteria
- [ ] `src/auth/throttler.config.ts` and `org-throttler.guard.ts` exist.
- [ ] `getTracker` returns the `org` claim.
- [ ] Storage is the Redis service, not in-memory.
- [ ] `OrgThrottlerGuard` is registered after `JwtAuthGuard` and before `ProgramScopeGuard`.
- [ ] All five test cases pass, including cross-org independence and same-org token sharing.

---

### Task 12: Wire logging, validation, metrics and health (T031–T033)

#### Objective

Structured JSON logs with the correlation id, a global strict `ValidationPipe`, the Prometheus
metric set, and health probes whose readiness distinguishes disconnected from merely lagging.

#### Files
- `src/observability/metrics.ts` — create.
- `src/observability/metrics.module.ts` — create.
- `src/observability/health.controller.ts` — create.
- `src/observability/health.module.ts` — create.
- `src/observability/index.ts` — create.
- `src/main.ts` — modify. Add the `ValidationPipe` and the pino logger.
- `src/app.module.ts` — modify. Register `LoggerModule`, `CorrelationMiddleware`, `AuthModule`,
  `MetricsModule`, `HealthModule`.
- `test/integration/health.spec.ts` — create.
- `test/unit/metrics.spec.ts` — create.

#### Implementation

1. In `src/main.ts`:
   - `app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true,
     transform: true }))`. `whitelist: true` is required by Constitution V.
   - `app.useLogger(app.get(Logger))` from `nestjs-pino`.
   - Keep the existing config validation; it already fails fast on a missing secret.

2. In `src/app.module.ts`, register `LoggerModule.forRoot` with:
   - `pinoHttp.genReqId` returning the correlation id resolved by the middleware;
   - a `customProps` adding `correlationId`;
   - **`redact`** covering `req.headers.authorization`, `req.headers.cookie` and
     `req.headers["x-api-key"]`, so a bearer token never reaches a log line;
   - `formatters.level` emitting the level as a string, and no `prettyPrint` — production logs are
     JSON.

   Apply `CorrelationMiddleware` via `configure(consumer)` for all routes, and register it
   **before** the logger so `genReqId` can read the resolved value.

3. `src/observability/metrics.ts` creates and exports these `prom-client` collectors on the
   default registry (research R10, FR-032, FR-019b):
   - `reservation_outcomes_total` — `Counter`, labels `outcome` and `reason`.
   - `ledger_append_duration_seconds` — `Histogram`, buckets
     `[0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5]`.
   - `consumer_lag_messages` — `Gauge`, label `program_id`.
   - `over_limit_programs` — `Gauge`, no labels.
   - `dlq_depth` — `Gauge`, no labels.
   - `investigation_required_programs` — `Gauge`, no labels.

   Also call `collectDefaultMetrics()` once. Export a `metricsRegistry` and a
   `resetMetrics()` helper for tests.

   Guard every collector construction so that re-importing the module in a test does not throw
   `A metric with the name ... has already been registered` — check
   `register.getSingleMetric(name)` first and reuse it.

4. `src/observability/health.controller.ts` exposes `GET /health/live` and `GET /health/ready`,
   both decorated `@Public()` — **and nothing else in the application is public.**
   - `/health/live` returns `{ status: 'ok' }` unconditionally.
   - `/health/ready` checks the database via `TypeOrmHealthIndicator.pingCheck`. It **does not**
     fail merely because the Kafka consumer is lagging (FR-007c, research R10): a lagging service
     still serves reads and reservations correctly. It fails when the consumer is *disconnected* —
     since no consumer exists until Phase 4, implement a `ConsumerHealthIndicator` that reports
     healthy when no consumer is registered, and leave a comment naming Phase 4 as the task that
     makes it meaningful.
   - The response body is the minimal `Health` schema from `contracts/http-api.yaml`. It names no
     host, broker, connection string, or version. Set Terminus's error body explicitly rather than
     letting it echo the driver message.

5. `test/integration/health.spec.ts`:
   - `/health/live` returns 200 with no token — proving `@Public()` works end to end.
   - `/health/ready` returns 200 when the database is up.
   - **The ready body leaks nothing**: assert the JSON, stringified, contains no `postgres`, no
     `5432`, no `localhost`, and no `password`.
   - `/health/ready` returns 503 when the database is unreachable (point the test module at a
     closed port), and that body also leaks none of the above.

6. `test/unit/metrics.spec.ts`: asserts all six named collectors are registered, that
   `reservation_outcomes_total` carries both `outcome` and `reason` labels, and that importing the
   module twice does not throw.

#### Constraints
- `src/observability/**` may import `shared` and `config` only. Do not import from `capacity/` or
  `treasury/` — the metrics module is a registry that others write to, not a consumer of them.
- `whitelist: true` is mandatory; do not relax it.
- No health response may contain a hostname, port, connection string, driver message or version.
- Do not expose the `/metrics` endpoint publicly without auth in this task; register the
  collectors only. Exposure is a Phase 9 concern.

#### Edge Cases
- `prom-client`'s default registry is process-global, so Jest running multiple suites in one
  worker will double-register. The `getSingleMetric` guard handles it; the double-import test
  pins the behaviour.
- The correlation middleware must run before pino, or `genReqId` sees `undefined` and every log
  line gets a fresh unrelated id.

#### Verification

```bash
npx jest test/integration/health.spec.ts test/unit/metrics.spec.ts
npm run typecheck
npm run lint
npm run build
```

Expected: all exit 0.

#### Completion Criteria
- [ ] All five observability source files exist; `main.ts` and `app.module.ts` are updated.
- [ ] `ValidationPipe` is global with `whitelist: true`.
- [ ] Pino `redact` covers `authorization`.
- [ ] All six collectors exist with the specified types and labels.
- [ ] Only `/health/live` and `/health/ready` carry `@Public()`.
- [ ] The leak assertions pass for both the 200 and the 503 readiness body.

---

### Task 13: Implement the seed script (T034)

#### Objective

A script that creates two organisations, three programs, FX rates at the exact stated values, and
prints a token per organisation to stdout — never to a file in the repository.

#### Files
- `scripts/seed.ts` — create.
- `test/integration/seed.spec.ts` — create.

#### Implementation

1. `scripts/seed.ts` connects using `dataSourceOptions` from `src/config/data-source.ts`, runs
   inside one transaction, and is **idempotent**: re-running it must not duplicate rows. Use fixed
   UUIDs so re-runs are `ON CONFLICT (id) DO NOTHING`.

   It creates:
   - **Two organisations**: `Northwind Trading` and `Contoso Finance`, with fixed UUIDs declared
     as constants at the top of the file.
   - **Three programs**: two owned by Northwind (one `USD`, one `EUR`), one owned by Contoso
     (`USD`). Each gets its credit limit established the only legal way — **by appending a
     `LIMIT_CHANGE` ledger entry through `advancePosition` and persisting it**, not by writing
     `credit_limit_minor` directly. Constitution II forbids setting a position behind the ledger's
     back, and the seed is not exempt; a seed that wrote the column directly would make SC-004b
     false from the first row. Limits: Northwind USD `10_000_000_00n`, Northwind EUR
     `5_000_000_00n`, Contoso USD `2_000_000_00n`.
   - **FX rates**, exactly: `EUR`→`USD` at `1.0850000000`, `effective_at` at the Unix epoch
     (`new Date(0)`), `source` `'seed'`. `quickstart.md` Scenario 4 depends on this precise rate
     being checkable, so do not round, adjust or make it "more realistic". Also seed the inverse
     `USD`→`EUR` at `0.9216589862` with the same effective time and source.
   - **One token per organisation**, signed HS256 with `process.env.JWT_SECRET`, carrying `org`
     (the organisation's UUID), `scope` `'capacity:read capacity:write capacity:audit'`, and `exp`
     24 hours out.

2. The tokens are written to **stdout only**. The script must not write them to any file, and must
   not write them anywhere under the repository. Add this comment above the print:

```ts
// Tokens go to stdout and nowhere else. Writing them to a file in the repository is how
// a development credential becomes a committed one.
```

3. The script exits non-zero with a clear message if `JWT_SECRET` or `DATABASE_URL` is unset,
   rather than seeding a database nobody can then authenticate against.

4. `test/integration/seed.spec.ts`, against the Task 6 Testcontainers Postgres with migrations
   applied:
   - Running the seed creates 2 organisations, 3 programs, 2 FX rates.
   - **Running it twice produces the same counts** — idempotence.
   - For every program, the `credit_limit_minor` column equals
     `SUM(delta_minor) WHERE component = 'LIMIT'` — the seed respected the ledger.
   - Every program also has exactly one `LIMIT_CHANGE` ledger entry with `sequence = 1`.
   - The EUR→USD rate is exactly `1.0850000000` and its source is `seed`.
   - The minted tokens verify under HS256 with the configured secret and carry all three scopes.
   - `git status --porcelain` after a seed run reports no new files — proving nothing was written
     into the repository.

#### Constraints
- Do not write `credit_limit_minor` directly. Route it through `advancePosition`.
- Do not write a token, secret or credential to any file.
- Do not change the stated FX rate.
- The script is not a Nest application; it may import from `capacity/domain` and
  `capacity/infrastructure` directly. `scripts/` is outside `src/` and so outside the
  `boundaries/include` glob — it is unconstrained by the matrix, deliberately.

#### Edge Cases
- Seeding against a database with no migrations applied must fail with a clear message, not a raw
  driver error about a missing relation. Check for the `program` table first.
- A second run must not append a second `LIMIT_CHANGE` entry, or the ledger sum would double while
  the `ON CONFLICT DO NOTHING` left the cache alone — breaking the very invariant the test
  asserts. Guard the ledger append on the program not already existing.

#### Verification

```bash
docker compose up -d postgres
npm run migration:run
JWT_SECRET=local_dev_only_not_a_real_secret_value_32 npm run seed
npx jest test/integration/seed.spec.ts
git status --porcelain
```

Expected:
- The seed prints two tokens to stdout and exits 0.
- The test exits 0 with all seven assertions passing.
- `git status --porcelain` shows no new untracked file.

#### Completion Criteria
- [ ] `scripts/seed.ts` and its spec exist.
- [ ] Credit limits are established via `advancePosition`, and the ledger-sum assertion passes.
- [ ] EUR→USD is exactly `1.0850000000`, source `seed`, effective at the epoch.
- [ ] Tokens print to stdout and no file is created.
- [ ] A second run changes no counts.

---

## Final Verification

Run the whole gate set from a clean state. This is the first point in the project at which
`npm run test:cov` is expected to **pass** — Phase 1 left it failing by design because `src/` was
almost empty, and this phase is what fills it.

1. Reset the local stack and bring it up.
2. Apply migrations, revert, re-apply.
3. Seed.
4. Run every gate.

Commands:

```bash
docker compose down -v
docker compose up -d
npm ci
npm run lint
npm run typecheck
npm test
npm run test:cov
npm run build
npm run migration:run
npm run migration:revert
npm run migration:run
JWT_SECRET=local_dev_only_not_a_real_secret_value_32 npm run seed
./scripts/verify-uat.sh
git status --porcelain
```

Expected:
- `lint` exits 0 with **zero deprecation warnings**.
- `typecheck` exits 0.
- `test` exits 0.
- **`test:cov` exits 0** — all four counters at or above 80%. If it does not, add the missing
  tests. Do **not** lower `coverageThreshold` in `jest.config.ts` under any circumstance; that
  threshold is the Constitution VI merge gate and lowering it is the one change this plan
  forbids outright.
- `build` exits 0.
- The migration run/revert/run cycle completes without error.
- The seed prints two tokens to stdout.
- `verify-uat.sh` exits 0.
- `git status --porcelain` is empty apart from intended source changes — no `.env`, no token file,
  no `coverage/`, no `node_modules/`.

Also confirm by inspection:
- `grep -rn "element-types" eslint.config.mjs` → no match.
- `grep -rnE "\bNumber\(|parseFloat" src/shared/money/ src/capacity/domain/` → no match.
- `grep -n "PRIMARY KEY (organisation_id, request_id)" src/migrations/*.ts` → one match.
- `grep -n "WHEN (NEW.local_reserved_minor > OLD.local_reserved_minor)" src/migrations/*.ts` → one
  match.
- `grep -rn "algorithms: \['HS256'\]" src/auth/` → one match.
- No file in `src/` exceeds 800 lines: `find src -name '*.ts' -exec wc -l {} + | sort -rn | head -5`.

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
15. **Never lower `coverageThreshold` in `jest.config.ts`, and never weaken a test assertion to
    make it pass.** If an assertion fails, the defect is in the implementation.

The executor may stop only for a concrete blocker such as:

- a referenced file, API, dependency, or subsystem does not exist;
- repository state materially contradicts facts the plan depends on;
- a required credential or external resource is unavailable;
- the prescribed implementation is technically impossible;
- executing the plan would require making an architectural or product decision not covered by the
  plan;
- two instructions in the plan directly contradict each other;
- verification proves that an assumption fundamental to the planned implementation is false.

When stopping, the executor must report: the task number; the exact blocker; the evidence
establishing the blocker; which plan assumption is invalid; the minimum planning decision required
to continue.

The executor must **not** propose or implement an alternative unless explicitly asked to re-plan.
