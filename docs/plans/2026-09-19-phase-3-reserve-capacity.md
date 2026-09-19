# Execution Plan: Phase 3 — Reserve capacity when an invoice is approved (User Story 1, P1 MVP)

## Goal

`POST /v1/programs/{programId}/reservations` accepts an approved invoice in any currency, converts
it into the program's currency at a recorded rate, appends a `+A` `LOCAL` ledger entry with cause
`RESERVATION` under the program row lock, and can never let this service's own reservations push a
program past its credit limit — with every refusal a typed outcome that applies nothing.

## Current State

Facts established by reading the repository at commit `a75d8c6`, not assumed:

- **Phases 1 and 2 are merged.** `src/capacity/domain/position.ts` (`advancePosition`),
  `src/shared/money/` (`money.ts`, `convert.ts`), `src/capacity/infrastructure/unit-of-work.ts`
  (`UnitOfWork.withProgramLock`), `src/capacity/infrastructure/repositories/`
  (`ProgramRepository.persistAdvance`, `LedgerRepository.sumByComponent`), the auth guard chain,
  the throttler, observability and `scripts/seed.ts` all exist and are green.
- **All ten tables already exist** from `src/migrations/1758240000000-InitialSchema.ts`. This phase
  adds **no new table**. `invoice_reservation`, `request_record` and `fx_rate` are in place with
  their CHECK constraints.
- **There is no controller yet.** `src/capacity/api/` does not exist. `AppModule` imports
  `ConfigurationModule`, `TypeOrmModule`, `LoggerModule`, `AuthModule`, `MetricsModule`,
  `HealthModule` — there is no `CapacityModule`.
- **`advancePosition(program, entries, now)`** returns `{ program, entries }`, assigns per-program
  sequences, and appends a zero-delta `OVER_LIMIT_ONSET` / `OVER_LIMIT_CLEARED` entry when the
  over-limit state flips. It is the only writer of the program row, through
  `ProgramRepository.persistAdvance(manager, programId, result, now)`.
- **`convert(amount, targetCurrency, scaledRate)`** returns `{ kind: 'converted', amount }` or
  `{ kind: 'roundsToZero' }` and never throws. `scaleRate(rate: string): bigint` scales a decimal
  rate string by `RATE_SCALE = 10n ** 10n`.
- **`UnitOfWork.withProgramLock(programId, fn)`** opens a `READ COMMITTED` transaction, runs
  `SELECT * FROM program WHERE id = $1 FOR UPDATE`, throws `ProgramNotFoundError` when absent, and
  hands `fn` `{ manager, program }` where `program` is a hydrated `ProgramEntity`.
- **The guard chain is global** via `APP_GUARD` in `AuthModule`, ordered `JwtAuthGuard` →
  `OrgThrottlerGuard` → `ProgramScopeGuard` → `ScopeGuard`. `ProgramScopeGuard` resolves ownership
  only for a route parameter named exactly **`programId`**, and answers `NOT_FOUND` for both a
  missing program and one belonging to another organisation. `request.auth` is
  `{ org: string; scopes: Set<string> }`.
- **Two named throttlers** (`read` 600/min, `write` 120/min) are registered globally, so today
  every route consumes **both** budgets.
- **`seed.ts` seeds** organisations `a1b2c3d4-0001-…-000000000001` (Northwind) and `…0002` (Contoso),
  programs `b1b2c3d4-0001-…-000000000011` (Northwind USD, limit `10_000_000_00n`),
  `…0012` (Northwind EUR, limit `5_000_000_00n`), `…0013` (Contoso USD, limit `2_000_000_00n`), and
  FX rates `EUR→USD 1.0850000000` and `USD→EUR 0.9216589862`, both with `effective_at = new Date(0)`,
  source `seed`.
- **Integration tests** boot a Testcontainers Postgres through `test/support/postgres-container.ts`
  (which returns `ownerUrl` **and** `appUrl` for the non-owner `capacity_app` role) and Redis
  through `test/support/redis-container.ts`. `test/integration/auth.spec.ts` is the reference for
  the `ConfigService` stub, the `ThrottlerStorage` override and JWT minting with `jsonwebtoken`.
- **`jest.config.ts`** has `roots: ['<rootDir>/src', '<rootDir>/test']`, `testRegex: '.*\.spec\.ts$'`
  and a global 80% `coverageThreshold`. A new `test/contract/` directory is picked up with no config
  change.
- **The boundaries matrix** in `eslint.config.mjs` allows `api → application | domain | shared` and
  `application → domain | infrastructure | shared | fx | config`. It does **not** allow `api → auth`
  or `application → observability`. `Public` was already moved to `src/shared/public/` for exactly
  this reason; `RequiredScope` still lives only in `src/auth/`.

### Two defects found during planning

1. **`IDEMPOTENCY_EXPIRED` is unrepresentable.** `data-model.md` says the retention sweep nulls
   `outcome` after 30 days while keeping the row as a tombstone, but the migration carries
   `CONSTRAINT request_record_state_outcome CHECK ((state = 'COMPLETE') = (outcome IS NOT NULL))`
   and the `request_state` enum has only `PENDING` and `COMPLETE`. Nulling `outcome` on a `COMPLETE`
   row violates the CHECK, so the sweep could never run and `IDEMPOTENCY_EXPIRED` could never be
   reached. Task 3 adds an `EXPIRED` enum value; the existing CHECK is already satisfied by it
   (`('EXPIRED' = 'COMPLETE') = (NULL IS NOT NULL)` is `false = false`), so the CHECK is left alone.
2. **`lagSeconds` has no true source yet.** `Availability.treasury.lagSeconds` is specified as the
   gap to the newest message *available on the stream*, but nothing records a stream high-water
   mark until the Phase 7 consumer exists. Task 7 defines an explicit interim derivation and marks
   it for replacement.

## Target State

- `POST /v1/programs/{programId}/reservations` returns 201 on create, 200 on an exact idempotent
  replay, and a typed 400/401/403/404/409/429/503 otherwise, all shaped as
  `contracts/errors.md` requires and carrying `correlationId`.
- Every accepted reservation writes, in **one** transaction under `SELECT … FOR UPDATE` on the
  program row: a `PENDING` then `COMPLETE` `request_record`, an `invoice_reservation` row with the
  FX rate/effective time/source denormalised onto it, one `capacity_ledger_entry` (plus an
  over-limit marker entry when the state flips), and the updated `program` row.
- 1,000 concurrent reservations against a program never breach the limit, the ledger sums to the
  cached position, and nothing fails for contention alone.
- The three FEAT-2 review carry-overs are closed (Tasks 1, 2 and 10).

## Scope

### In Scope
- tasks.md T035–T046 (Phase 3, User Story 1).
- Carry-over A: ioredis `'error'` listener, `quit()` on shutdown, `enableShutdownHooks()`.
- Carry-over B: `@SkipThrottle` scoping so the write route consumes only the `write` budget.
- Carry-over C: the re-`GRANT` rule for new tables — see the note below.
- The `request_state` `EXPIRED` migration and the matching `data-model.md` correction.

### Out of Scope
- `GET /v1/programs/{programId}/availability` as a route (Phase 5 / US4). This plan builds the
  availability **projection** because `ReservationResponse` embeds it, but adds no GET route.
- Releases, cancellations, the Kafka consumer, snapshots (Phases 4, 6, 7, 8).
- The 30-day retention sweep job that sets `state = 'EXPIRED'` (Phase 9). This plan makes the state
  representable and honours it on read; it does not schedule the sweep.
- True stream-lag measurement (Phase 7).

### Carry-over C, resolved
**This phase adds no new table**, so `GRANT … ON ALL TABLES IN SCHEMA public TO app_role` needs no
repeat. Task 3's migration only adds an enum value, which carries no table privilege. The rule is
recorded as a constraint on Task 3 so the next phase that *does* add a table cannot miss it.

## Key Decisions

1. **`RequiredScope` moves to `src/shared/scope/`**, re-exported from `src/auth/required-scope.ts`
   so existing imports keep working. The controller lives in `api`, which the boundaries matrix
   forbids from importing `auth`. This mirrors the repository's own precedent — `Public` was moved
   to `src/shared/public/` for the identical reason. Rejected: widening the matrix to `api → auth`,
   which would let a controller reach a guard's internals.
2. **The boundaries matrix gains `application → observability`.** `reservationOutcomesTotal` lives
   in `src/observability/metrics.ts` and the reserve service is the only place that knows the
   outcome. `treasury → observability` is already allowed, so this is consistent, not novel.
   `domain → observability` stays forbidden — the policy stays pure.
3. **The FX port takes no `EntityManager`.** `FxRateProvider.rateFor(base, quote, asOf)` returns a
   promise; the adapter owns its own `DataSource`. Rates are immutable reference data, so reading
   them outside the reservation transaction is safe and keeps `src/capacity/domain/` free of any
   TypeORM type.
4. **Duplicate invoices are detected by a `SELECT` under the program lock**, not by catching
   `23505`. Because the caller already holds `FOR UPDATE` on the program, two concurrent inserts for
   the same `(program_id, invoice_id)` are serialised, so the pre-check is reliable. The unique
   constraint stays as a backstop, and if it ever fires the service **rethrows and lets the
   transaction roll back** — after a `23505` the transaction is aborted and no further statement in
   it can succeed, so catching-and-continuing is not an option.
5. **Refusals roll the transaction back**, including the `PENDING` `request_record`. A refusal
   applies nothing, so the idempotency key must remain reusable.
6. **The check order in the reserve policy is fixed**: `POSITION_UNVERIFIED` → `PROGRAM_OVER_LIMIT`
   → `FX_RATE_UNAVAILABLE` → `AMOUNT_ROUNDS_TO_ZERO` → `INSUFFICIENT_CAPACITY`. A rate is needed
   before rounding can be evaluated, and rounding before capacity, because a zero amount would
   otherwise report a capacity failure it did not cause.
7. **Tests are written first inside the task that implements what they test.** tasks.md marks
   T035–T038 "WRITE FIRST, CONFIRM FAILING". Running them as separate tasks would leave the
   repository failing to typecheck across task boundaries, which the one-sub-agent-per-task topology
   handles badly. Each implementation task therefore starts by writing its test and observing it
   fail. The two end-to-end integration tests (T035, T036) and the contract test (T038) remain
   separate tasks *after* the endpoint, because they exercise the whole stack and cannot be written
   against a route that does not exist.
8. **`js-yaml@5.4.2`, `ajv@8.20.0`, `ajv-formats@3.0.1`** are added as devDependencies for the
   contract test. Versions verified against the registry, not recalled. `js-yaml` v5 ships its own
   types and a CommonJS entry, so no `@types/js-yaml`. OpenAPI 3.1 schemas are JSON Schema 2020-12,
   so Ajv's 2020 dialect (`ajv/dist/2020`) validates them directly.
9. **A currency minor-unit table is added** at `src/shared/money/minor-units.ts`. `toDecimalString`
   already takes `minorUnitDigits` as a parameter and nothing supplies it yet.
10. **The global `ValidationPipe` is extracted** to `src/shared/validation/create-validation-pipe.ts`
    so `main.ts` and every test build the identical pipe. A test that configures its own pipe
    differently would prove nothing about production behaviour.

## Execution Order

### Task 1: Harden the Redis client lifecycle and register shutdown hooks

#### Objective
Stop a Redis connection error from killing the process, and close the client on shutdown.

#### Files
- `src/auth/throttler.config.ts` — modify. Currently constructs `new Redis(url, { maxRetriesPerRequest: 3 })` inline inside `createThrottlerOptions` with no error handling and no way to close it.
- `src/main.ts` — modify. Add `app.enableShutdownHooks()`.
- `src/auth/redis.provider.ts` — create. Owns construction, error logging and disposal.
- `test/unit/redis-provider.spec.ts` — create.

#### Implementation
1. Create `src/auth/redis.provider.ts`:

```ts
import { Logger } from '@nestjs/common';
import Redis from 'ioredis';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

export function createRedisClient(url: string, logger: Logger): Redis {
  const client = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false });
  // Without this listener an emitted 'error' is an unhandled error event and
  // terminates the process: a Redis blip would take down the API rather than
  // degrading rate limiting.
  client.on('error', (error: Error) => {
    logger.error(`redis client error: ${error.message}`);
  });
  return client;
}
```

2. In `src/auth/throttler.config.ts`, change `createThrottlerOptions(config: ConfigService)` to
   `createThrottlerOptions(config: ConfigService, client: Redis)` and pass `client` straight to
   `new ThrottlerStorageRedisService(client)`. It must no longer construct a client itself.
3. In `src/auth/auth.module.ts`:
   - add a provider `{ provide: REDIS_CLIENT, inject: [ConfigService], useFactory: (config: ConfigService) => createRedisClient(config.getOrThrow<string>('REDIS_URL'), new Logger('RedisClient')) }`;
   - change the `ThrottlerModule.forRootAsync` factory to `inject: [ConfigService, REDIS_CLIENT]` and `useFactory: (config: ConfigService, client: Redis) => createThrottlerOptions(config, client)`;
   - make `AuthModule` implement `OnApplicationShutdown`, injecting `@Inject(REDIS_CLIENT) private readonly redis: Redis`, with `async onApplicationShutdown(): Promise<void> { await this.redis.quit(); }`;
   - export `REDIS_CLIENT`.
4. In `src/main.ts`, call `app.enableShutdownHooks();` immediately after `app.useGlobalPipes(...)`.
   Without it `onApplicationShutdown` never runs on SIGTERM.

#### Constraints
- Do not change the throttler limits, TTLs or the `getTracker` behaviour.
- Do not replace `ioredis` or add a Redis module dependency.
- `test/integration/auth.spec.ts` and `test/integration/rate-limit.spec.ts` override `ThrottlerStorage` directly and must keep passing unchanged. If they fail, the change to `createThrottlerOptions` is wrong — fix the source, not the tests.

#### Edge Cases
- `quit()` on an already-closed client rejects; wrap the call in `try { await this.redis.quit(); } catch { /* already closed */ }`.
- `REDIS_URL` absent: `getOrThrow` already fails at startup. Keep that behaviour.

#### Verification
```bash
npm run lint && npm run typecheck && npx jest test/unit/redis-provider.spec.ts test/integration/rate-limit.spec.ts
```

Expected:
- The unit test asserts `createRedisClient` returns a client with at least one `'error'` listener (`client.listenerCount('error') >= 1`) against a URL pointing at a closed port, and that the emitted error is logged rather than thrown. Close the client in `afterEach`.
- `rate-limit.spec.ts` still passes.

#### Completion Criteria
- [ ] `src/auth/redis.provider.ts` exists and attaches an `'error'` listener.
- [ ] `createThrottlerOptions` no longer constructs a `Redis` instance.
- [ ] `AuthModule` implements `OnApplicationShutdown` and quits the client.
- [ ] `src/main.ts` calls `enableShutdownHooks()`.
- [ ] Lint, typecheck and the two named test files pass.

---

### Task 2: Move the required-scope decorator to shared and widen the boundaries matrix

#### Objective
Let a controller in `src/capacity/api/` declare its required scope, and let the application layer
record metrics, without either crossing a forbidden boundary.

#### Files
- `src/shared/scope/scope.decorator.ts` — create. Canonical `REQUIRED_SCOPE_KEY` and `RequiredScope`.
- `src/shared/scope/index.ts` — create. `export * from './scope.decorator';`
- `src/auth/required-scope.decorator.ts` — modify to a re-export.
- `eslint.config.mjs` — modify one policy line.

#### Implementation
1. `src/shared/scope/scope.decorator.ts` holds exactly what `src/auth/required-scope.decorator.ts`
   holds today:

```ts
import { SetMetadata } from '@nestjs/common';

export const REQUIRED_SCOPE_KEY = 'requiredScope';

export const RequiredScope = (scope: string) => SetMetadata(REQUIRED_SCOPE_KEY, scope);
```

2. Replace the body of `src/auth/required-scope.decorator.ts` with, mirroring the comment style
   already used in `src/auth/public.decorator.ts`:

```ts
// Canonical definition lives in shared so the api layer can declare its required
// scope without importing auth, which the boundary matrix forbids.
export { REQUIRED_SCOPE_KEY, RequiredScope } from '../shared/scope';
```

3. `src/auth/scope.guard.ts` keeps importing `REQUIRED_SCOPE_KEY` from `./required-scope.decorator`.
   Do not change it.
4. In `eslint.config.mjs`, change the `application` policy from

```js
{ from: 'application', allow: [{ to: [{ type: 'domain' }] }, { to: [{ type: 'infrastructure' }] }, { to: [{ type: 'shared' }] }, { to: [{ type: 'fx' }] }, { to: [{ type: 'config' }] }] },
```

to the same list with `{ to: [{ type: 'observability' }] }` appended. Change nothing else in the
matrix — in particular `domain` must not gain any new target.

#### Constraints
- Do not delete `src/auth/required-scope.decorator.ts`; `src/auth/index.ts` re-exports it and
  `test/integration/auth.spec.ts` imports from it.
- Do not add `api → auth` or `domain → observability` to the matrix.

#### Edge Cases
- Duplicate metadata key: both modules must resolve to the **same** string constant, which the
  re-export guarantees. Do not redeclare the literal `'requiredScope'` in two files.

#### Verification
```bash
npm run lint && npm run typecheck && npx jest test/integration/auth.spec.ts
```

Expected: all pass. `auth.spec.ts` exercises `@RequiredScope('capacity:read')` end to end, so a
broken re-export shows up as a 403 where a 200 is expected.

#### Completion Criteria
- [ ] `src/shared/scope/` exists and is the only place the metadata key is declared.
- [ ] `src/auth/required-scope.decorator.ts` is a re-export.
- [ ] `eslint.config.mjs` allows `application → observability` and nothing else new.
- [ ] Lint, typecheck and `auth.spec.ts` pass.

---

### Task 3: Add the EXPIRED request state and correct the data model

#### Objective
Make `IDEMPOTENCY_EXPIRED` representable, so a 30-day-old idempotency key can be refused as expired
instead of silently reprocessed.

#### Files
- `src/migrations/1758250000000-AddExpiredRequestState.ts` — create.
- `src/capacity/infrastructure/entities/request-record.entity.ts` — modify the enum union.
- `specs/001-program-capacity-reservation/data-model.md` — modify the `request_record` section.
- `test/migration/expired-request-state.spec.ts` — create.

#### Implementation
1. The migration, class `AddExpiredRequestState1758250000000`:

```ts
public async up(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`ALTER TYPE request_state ADD VALUE IF NOT EXISTS 'EXPIRED';`);
}

public async down(queryRunner: QueryRunner): Promise<void> {
  // Postgres cannot drop a value from an enum. The type is rebuilt without it.
  // Any row already carrying EXPIRED would block this, which is correct: the
  // down migration must refuse rather than silently discard an expiry tombstone.
  await queryRunner.query(`ALTER TYPE request_state RENAME TO request_state_old;`);
  await queryRunner.query(`CREATE TYPE request_state AS ENUM ('PENDING', 'COMPLETE');`);
  await queryRunner.query(
    `ALTER TABLE request_record
       ALTER COLUMN state TYPE request_state
       USING state::text::request_state;`,
  );
  await queryRunner.query(`DROP TYPE request_state_old;`);
}
```

2. In `request-record.entity.ts` change both the `enum:` array and the TypeScript union to
   `'PENDING' | 'COMPLETE' | 'EXPIRED'`. The column keeps `enumName: 'request_state'`.
3. In `data-model.md`, in the `request_record` table, change the `state` row's Notes from
   `` `PENDING` or `COMPLETE` `` to `` `PENDING`, `COMPLETE`, or `EXPIRED` ``, and append this
   paragraph immediately after the existing **Retention** paragraph:

> The sweep sets `state = 'EXPIRED'` at the same time as it nulls `outcome`. It cannot simply null
> `outcome` on a `COMPLETE` row: `CHECK ((state = 'COMPLETE') = (outcome IS NOT NULL))` would reject
> the update, so the retention rule as originally written was unexecutable. `EXPIRED` satisfies the
> existing CHECK unchanged, because `('EXPIRED' = 'COMPLETE')` and `(NULL IS NOT NULL)` are both
> false. A lookup that finds `EXPIRED` answers `IDEMPOTENCY_EXPIRED`; the identifier and fingerprint
> survive, so a reused key is still never mistaken for a new one.

#### Constraints
- **Do not alter `CONSTRAINT request_record_state_outcome`.** It is already correct for three states.
- Do not add, drop or alter any table. This phase creates no table, so no `GRANT … ON ALL TABLES …
  TO app_role` is needed. **Any future migration that creates a table must re-issue that GRANT** —
  the Phase 2 grant was a snapshot of the tables existing at that moment, not a standing policy.
- Do not write the retention sweep job. It belongs to Phase 9.

#### Edge Cases
- `ALTER TYPE … ADD VALUE` inside a transaction is permitted on PostgreSQL 12+ (this project runs
  16.10) but the new value cannot be *used* in that same transaction. The migration only adds it;
  nothing writes `EXPIRED` until a later transaction. Do not add a data statement to this migration.
- Re-running the migration: `IF NOT EXISTS` makes `up` idempotent.

#### Verification
```bash
docker compose up -d postgres
DATABASE_URL=postgres://capacity:capacity_local_dev@localhost:5432/capacity npm run migration:run
DATABASE_URL=postgres://capacity:capacity_local_dev@localhost:5432/capacity npm run migration:revert
DATABASE_URL=postgres://capacity:capacity_local_dev@localhost:5432/capacity npm run migration:run
npx jest test/migration
```

Expected:
- Run, revert and re-run all succeed.
- `test/migration/expired-request-state.spec.ts`, modelled on the existing
  `test/migration/migration.spec.ts` harness (Testcontainers Postgres, migrations run against
  `ownerUrl`), asserts that `SELECT unnest(enum_range(NULL::request_state))::text` returns exactly
  `['PENDING', 'COMPLETE', 'EXPIRED']`, and that
  `INSERT INTO request_record (…, state, outcome) VALUES (…, 'EXPIRED', NULL)` succeeds while
  `(…, 'COMPLETE', NULL)` raises SQLSTATE `23514`.

#### Completion Criteria
- [ ] The migration exists with a working `up` and `down`.
- [ ] `RequestRecordEntity.state` admits `'EXPIRED'`.
- [ ] `data-model.md` records the state and the reason.
- [ ] Migration run → revert → run succeeds and `test/migration` passes.

---

### Task 4: FxRateProvider port and the static and cached adapters (T039, T040)

#### Objective
Resolve an invoice→program rate through a port the domain owns, with a database-backed adapter and
a configuration-backed one, neither of which the domain imports.

#### Files
- `src/capacity/domain/ports/fx-rate.provider.ts` — create. The port and its types.
- `src/fx/static-rate.provider.ts` — create.
- `src/fx/cached-rate.provider.ts` — create.
- `src/fx/index.ts` — create.
- `test/unit/fx-rate-provider.spec.ts` — create. **Write this first and watch it fail.**

#### Implementation
1. The port:

```ts
// src/capacity/domain/ports/fx-rate.provider.ts
/** A rate resolved for a currency pair, with everything needed to denormalise it. */
export interface FxRate {
  /** The rate scaled by RATE_SCALE (10n ** 10n), ready for `convert`. */
  readonly scaledRate: bigint;
  /** The canonical decimal string as stored, e.g. '1.0850000000'. Written to the reservation row. */
  readonly rate: string;
  readonly effectiveAt: Date;
  readonly source: string;
}

export interface FxRateProvider {
  /** Newest rate with effective_at <= asOf, or null when the pair has none. */
  rateFor(base: string, quote: string, asOf: Date): Promise<FxRate | null>;
}

export const FX_RATE_PROVIDER = Symbol('FX_RATE_PROVIDER');
```

2. `StaticRateProvider` takes `readonly rates: ReadonlyArray<{ base: string; quote: string; rate: string; effectiveAt: Date; source: string }>` in its constructor, selects the newest entry for the
   pair with `effectiveAt <= asOf`, and returns `null` otherwise. It calls `scaleRate(rate)` from
   `../shared/money` to fill `scaledRate`. It performs no I/O and is what unit tests use.
3. `CachedRateProvider` is `@Injectable()`, takes `DataSource`, and implements `rateFor` as:

```sql
SELECT rate, effective_at, source
  FROM fx_rate
 WHERE base_currency = $1 AND quote_currency = $2 AND effective_at <= $3
 ORDER BY effective_at DESC
 LIMIT 1
```

   It caches on the key `` `${base}:${quote}` `` in a `Map<string, { value: FxRate; expiresAt: number }>`
   with a 60_000 ms TTL, using `Date.now()`. A cache miss or expired entry re-queries. A `null`
   result is **not** cached — a rate that arrives must be visible within the request that needs it.
   It exposes `clearCache(): void` for tests.
4. `src/fx/index.ts` re-exports both providers.

#### Constraints
- `src/capacity/domain/**` may import only `domain` and `shared`. The port file must import nothing
  but types it declares — **no TypeORM import, no `EntityManager` parameter**.
- `src/fx/**` may import only `domain`, `shared` and `config`.
- Do not call `Number`, `parseFloat` or `Math.*` on a rate. `scaleRate` is the only parser.
- Do not add a rate-fetching HTTP client. SC-008 requires local operation with no external network.

#### Edge Cases
- `base === quote`: the provider is simply not consulted; the caller decides. Do not special-case it
  inside the provider.
- Multiple rows with the same `effective_at`: the PK is `(base, quote, effective_at)`, so this cannot
  happen.
- A row whose `rate` column is `NULL`: the column is `NOT NULL` in the schema, but the entity types
  it `string | null`. Treat a null as **no rate** and return `null` rather than throwing.
- `asOf` earlier than every stored `effective_at`: returns `null` → the caller answers
  `FX_RATE_UNAVAILABLE`.

#### Verification
```bash
npx jest test/unit/fx-rate-provider.spec.ts && npm run lint && npm run typecheck
```

Expected test cases in `test/unit/fx-rate-provider.spec.ts`, all against `StaticRateProvider`:
- `rateFor('EUR', 'USD', now)` with the seeded `1.0850000000` returns `scaledRate === 10850000000n`
  and `rate === '1.0850000000'`.
- `rateFor('EUR', 'GBP', now)` returns `null`.
- With two entries for one pair, the one with the later `effectiveAt` wins.
- An entry whose `effectiveAt` is after `asOf` is not selected.

#### Completion Criteria
- [ ] The port exists in `domain/ports/` and imports no infrastructure type.
- [ ] Both adapters exist in `src/fx/` and compile.
- [ ] The four listed test cases pass.
- [ ] `npm run lint` reports no `boundaries/dependencies` error.

---

### Task 5: The reserve policy (T037, T041)

#### Objective
Decide, as a pure function, whether a reservation is accepted — and if refused, exactly why, in a
fixed order of precedence.

#### Files
- `src/capacity/domain/policies/reserve.policy.ts` — create.
- `src/capacity/domain/errors.ts` — create. The typed refusal codes shared by domain, application and api.
- `test/unit/reserve-policy.spec.ts` — create. **Write this first and watch it fail.**

#### Implementation
1. `src/capacity/domain/errors.ts`:

```ts
export type RefusalCode =
  | 'POSITION_UNVERIFIED'
  | 'PROGRAM_OVER_LIMIT'
  | 'FX_RATE_UNAVAILABLE'
  | 'AMOUNT_ROUNDS_TO_ZERO'
  | 'INSUFFICIENT_CAPACITY'
  | 'DUPLICATE_INVOICE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_EXPIRED'
  | 'REQUEST_IN_FLIGHT';

/** A refusal that changed nothing. Carries no internal state. */
export class CapacityRefusal extends Error {
  constructor(
    readonly code: RefusalCode,
    readonly details?: Readonly<Record<string, string>>,
  ) {
    super(code);
    this.name = 'CapacityRefusal';
  }
}
```

2. `src/capacity/domain/policies/reserve.policy.ts`:

```ts
export type FxResolution =
  | { readonly kind: 'sameCurrency' }
  | { readonly kind: 'rate'; readonly rate: FxRate }
  | { readonly kind: 'unavailable' };

export type ReserveDecision =
  | { readonly kind: 'accepted'; readonly reservedMinor: bigint; readonly fx: FxRate | null }
  | { readonly kind: 'refused'; readonly code: RefusalCode; readonly details?: Record<string, string> };

export function decideReservation(input: {
  readonly program: ProgramPosition;
  readonly invoiceAmountMinor: bigint;
  readonly fx: FxResolution;
}): ReserveDecision;
```

   The body, in this exact order:
   1. `program.positionVerified === false` → refused `POSITION_UNVERIFIED`.
   2. `isOverLimit(program)` (already exported from `domain/program.ts`) → refused `PROGRAM_OVER_LIMIT`.
   3. `fx.kind === 'unavailable'` → refused `FX_RATE_UNAVAILABLE`.
   4. Compute `reservedMinor`: for `sameCurrency` it is `invoiceAmountMinor`; for `rate` it is
      `convert(money(invoiceAmountMinor, 'XXX'), 'XXX', fx.rate.scaledRate)` — call `convert` and, on
      `{ kind: 'roundsToZero' }`, return refused `AMOUNT_ROUNDS_TO_ZERO`; otherwise take
      `amount.minor`. The currency argument is irrelevant to the arithmetic here; pass the program's
      currency so the value is meaningful if it is ever logged.
   5. `reservedMinor > available(program)` (both already exported from `domain/program.ts`) → refused
      `INSUFFICIENT_CAPACITY` with `details` `{ requestedMinor: reservedMinor.toString(), availableMinor: available(program).toString() }`.
   6. Otherwise accepted, with `fx` set to `fx.rate` for the `rate` case and `null` for `sameCurrency`.

#### Constraints
- Pure. No `Date`, no I/O, no logging, no metrics, no randomness. `now` is not a parameter.
- Do not mutate `input.program`.
- `available()` is signed and is never floored at zero; a negative available with a positive request
  falls out as `INSUFFICIENT_CAPACITY` through the same comparison. Do not add a floor.
- Do not consult the database trigger. `data-model.md` is explicit: the trigger is the backstop,
  never the primary gate.

#### Edge Cases
- `invoiceAmountMinor <= 0`: rejected earlier by the DTO, and the table CHECK forbids it. The policy
  does **not** re-check it; do not add a branch for it.
- An over-limit program with plenty of nominal room: `PROGRAM_OVER_LIMIT` wins, because step 2 runs
  before step 5.
- `reservedMinor === available(program)` exactly: accepted. The comparison is `>`, not `>=`.
- `sameCurrency` never yields `AMOUNT_ROUNDS_TO_ZERO`, because no conversion happens.

#### Verification
```bash
npx jest test/unit/reserve-policy.spec.ts
```

Required test cases:
- Unverified program with ample capacity → `POSITION_UNVERIFIED`, **not** accepted.
- Over-limit program that is also unverified → `POSITION_UNVERIFIED` wins (order is asserted).
- Over-limit program, verified, ample nominal room → `PROGRAM_OVER_LIMIT`.
- `fx.kind === 'unavailable'` on a healthy program → `FX_RATE_UNAVAILABLE`.
- 1 JPY into USD at `scaleRate('0.0067')` → `AMOUNT_ROUNDS_TO_ZERO`.
- Request one minor unit above `available` → `INSUFFICIENT_CAPACITY` with both detail fields as
  decimal strings.
- Request exactly `available` → accepted.
- Cross-currency accept: `1_000_000_00n` EUR at `1.0850000000` → `reservedMinor === 108500000n`, and
  the returned `fx` is the same object passed in.
- The input `program` object is unchanged afterwards (compare against a pre-captured copy).

#### Completion Criteria
- [ ] `decideReservation` exists with the signature above and evaluates in the documented order.
- [ ] `CapacityRefusal` and `RefusalCode` exist in `domain/errors.ts`.
- [ ] All nine test cases pass.
- [ ] `npm run lint && npm run typecheck` pass.

---

### Task 6: The idempotency service (T042)

#### Objective
Make a repeated request return its original outcome, a differing one conflict, and two concurrent
copies apply exactly once — all inside the caller's transaction.

#### Files
- `src/capacity/application/idempotency.service.ts` — create.
- `test/unit/idempotency-fingerprint.spec.ts` — create. **Write first.**
- `test/integration/idempotency.spec.ts` — create. Exercises the real table.

#### Implementation

```ts
export type IdempotencyDecision =
  | { readonly kind: 'proceed' }
  | { readonly kind: 'replay'; readonly outcome: Record<string, unknown> }
  | { readonly kind: 'refused'; readonly code: 'IDEMPOTENCY_CONFLICT' | 'IDEMPOTENCY_EXPIRED' | 'REQUEST_IN_FLIGHT' };

export interface RequestIdentity {
  readonly organisationId: string;
  readonly requestId: string;
  readonly operation: 'RESERVE' | 'RELEASE' | 'CANCEL';
  readonly fingerprint: string;
}

@Injectable()
export class IdempotencyService {
  begin(manager: EntityManager, identity: RequestIdentity, now: Date): Promise<IdempotencyDecision>;
  complete(manager: EntityManager, identity: RequestIdentity, outcome: Record<string, unknown>): Promise<void>;
}

/** SHA-256 over the fields that determine the outcome (FR-006a). */
export function reserveFingerprint(input: {
  programId: string; invoiceId: string; amountMinor: string; currency: string;
}): string;
```

1. `reserveFingerprint` hashes the exact string
   `` `${programId}|${invoiceId}|${amountMinor}|${currency}` `` with `createHash('sha256')` from
   `node:crypto` and returns lowercase hex. A delimited string, not `JSON.stringify`, because key
   order in an object literal is not part of the contract.
2. `begin` runs, in this order, on the passed `manager` (never on a fresh connection — it must join
   the caller's transaction):
   - `INSERT INTO request_record (organisation_id, request_id, operation, content_fingerprint, state, outcome, recorded_at) VALUES ($1,$2,$3,$4,'PENDING',NULL,$5) ON CONFLICT (organisation_id, request_id) DO NOTHING RETURNING request_id`
   - If a row came back → `{ kind: 'proceed' }`.
   - Otherwise `SELECT state, content_fingerprint, outcome FROM request_record WHERE organisation_id = $1 AND request_id = $2` and map:
     - `content_fingerprint !== identity.fingerprint` → refused `IDEMPOTENCY_CONFLICT` (checked **first**, so a differing retry never replays);
     - `state === 'PENDING'` → refused `REQUEST_IN_FLIGHT`;
     - `state === 'EXPIRED'` → refused `IDEMPOTENCY_EXPIRED`;
     - `state === 'COMPLETE'` → `{ kind: 'replay', outcome }`.
3. `complete` runs `UPDATE request_record SET state = 'COMPLETE', outcome = $3 WHERE organisation_id = $1 AND request_id = $2`, passing the outcome as a JSON string cast to `jsonb`.

#### Constraints
- Every statement takes the caller's `EntityManager`. Do not inject `DataSource` and do not open a
  second transaction — a separate transaction would leave a `PENDING` row behind after the caller
  rolls back.
- Do not catch `23505` and continue: `ON CONFLICT DO NOTHING` is what keeps the transaction usable.
- Do not delete or update the row on refusal. Refusals roll back.
- The lookup **always** filters on both `organisation_id` and `request_id` (FR-006d).

#### Edge Cases
- A concurrent duplicate whose transaction is still open: the `INSERT … ON CONFLICT DO NOTHING`
  blocks on the uncommitted primary key until that transaction ends, then returns zero rows. If the
  other transaction committed, the follow-up `SELECT` sees `COMPLETE` and replays; if it rolled
  back, the insert succeeds. Both are correct; do not add a timeout or a retry loop.
- `outcome` of a `COMPLETE` row is never null — the table CHECK guarantees it. If the read somehow
  yields null, throw rather than returning `{ kind: 'replay', outcome: null }`.
- The same `requestId` under a different organisation is a different row entirely (composite PK).

#### Verification
```bash
npx jest test/unit/idempotency-fingerprint.spec.ts test/integration/idempotency.spec.ts
```

Required unit cases:
- The same input yields the same hex digest; changing any one of the four fields changes it.
- The digest is 64 lowercase hex characters.

Required integration cases (Testcontainers Postgres, migrations applied, one organisation and
program seeded):
- First `begin` → `proceed`; after `complete`, a second `begin` with the same fingerprint → `replay`
  carrying the stored outcome.
- `begin` with the same `requestId` but a different fingerprint → `IDEMPOTENCY_CONFLICT`.
- A row left `PENDING` by a committed transaction → `REQUEST_IN_FLIGHT`.
- A row manually set to `state = 'EXPIRED', outcome = NULL` → `IDEMPOTENCY_EXPIRED`.
- The same `requestId` under two different `organisation_id`s both → `proceed`.

#### Completion Criteria
- [ ] `IdempotencyService.begin` and `.complete` behave exactly as mapped above.
- [ ] `reserveFingerprint` is a delimited SHA-256, not a JSON hash.
- [ ] All listed unit and integration cases pass.

---

### Task 7: The availability projection and the currency minor-unit table

#### Objective
Render a program's position as the contract's `Availability` object, since `ReservationResponse`
embeds one and a caller must not need a second request.

#### Files
- `src/shared/money/minor-units.ts` — create.
- `src/shared/money/index.ts` — modify to re-export it.
- `src/capacity/application/availability.projection.ts` — create.
- `test/unit/availability-projection.spec.ts` — create. **Write first.**

#### Implementation
1. `src/shared/money/minor-units.ts`:

```ts
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'XOF', 'XAF', 'XPF']);
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

/** ISO-4217 minor unit digits. Defaults to 2, which is correct for the great majority. */
export function minorUnitDigits(code: string): number {
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}
```

2. `src/capacity/application/availability.projection.ts` exports:

```ts
export interface MoneyBody { readonly amountMinor: string; readonly currency: string; }

export interface AvailabilityBody {
  readonly programId: string;
  readonly currency: string;
  readonly creditLimit: MoneyBody;
  readonly reserved: { readonly total: MoneyBody; readonly local: MoneyBody; readonly treasury: MoneyBody };
  readonly available: MoneyBody;
  readonly positionVerified: boolean;
  readonly investigationRequired: boolean;
  readonly overLimit: { readonly active: boolean; readonly since: string | null };
  readonly positionChangedAt: string;
  readonly treasury: { readonly appliedVersion: number; readonly effectiveAt: string | null; readonly lagSeconds: number };
}

export function toAvailabilityBody(program: ProgramEntity, now: Date): AvailabilityBody;
```

   Rules:
   - Every `amountMinor` is `minor.toString()` — **minor units as a decimal string**, matching the
     `Money` schema's `^-?[0-9]+$`. It is *not* `toDecimalString`; the contract's `amountMinor` is
     minor units, not a major-unit decimal. `minorUnitDigits` exists for the release/rendering paths
     that need it and for the DTO's bounds check, not for this projection.
   - `available` is `creditLimitMinor - (localReservedMinor + treasuryReservedMinor)`, signed, never
     floored.
   - `overLimit.active` is `localReservedMinor + treasuryReservedMinor > creditLimitMinor`;
     `since` is `overLimitSince?.toISOString() ?? null`.
   - `treasury.appliedVersion` is `Number(program.treasuryVersion)`. The contract types it
     `integer, format: int64`; a treasury version large enough to lose precision as a JSON number is
     not reachable in this phase.
   - `treasury.lagSeconds`: `0` when `treasuryEffectiveAt` is null, otherwise
     `Math.max(0, (now.getTime() - program.treasuryEffectiveAt.getTime()) / 1000)`.
     **This is an interim derivation.** The contract defines lag against the newest message
     *available on the stream*, and no stream high-water mark is recorded until the Phase 7 consumer
     exists. Write this comment above the line. Do not attempt a truer figure now, and do not read
     `program_stream_position` — its `updated_at` is when this service last wrote, not when the
     broker last produced.
   - All timestamps are `toISOString()`.

#### Constraints
- `application` may import `domain`, `infrastructure`, `shared`, `fx`, `config` and (after Task 2)
  `observability`. It may not import `api`.
- Pure apart from reading `now`, which is a parameter. No database access.
- Do not floor `available` at zero.

#### Edge Cases
- `overLimitSince` null while `overLimit.active` is true cannot occur through `advancePosition`, but
  the projection must not crash: emit `since: null`.
- `treasuryEffectiveAt` in the future (clock skew) → `lagSeconds` clamps to `0` via `Math.max`.
- A program with zero reservations → `available` equals `creditLimit`, `overLimit.active` false.

#### Verification
```bash
npx jest test/unit/availability-projection.spec.ts test/unit/money.spec.ts
```

Required cases:
- A program with limit `10_000_000_00n`, local `1_000_00n`, treasury `2_000_00n` yields
  `available.amountMinor === '999700000'` and `reserved.total.amountMinor === '300000'`.
- An over-limit program yields a **negative** `available.amountMinor` string and
  `overLimit.active === true`.
- `treasuryEffectiveAt` 30 seconds before `now` yields `lagSeconds === 30`.
- `treasuryEffectiveAt` null yields `lagSeconds === 0` and `effectiveAt: null`.
- `minorUnitDigits('JPY') === 0`, `minorUnitDigits('KWD') === 3`, `minorUnitDigits('USD') === 2`.

#### Completion Criteria
- [ ] `toAvailabilityBody` produces every field the `Availability` schema marks required.
- [ ] `amountMinor` values are minor-unit strings.
- [ ] The interim-lag comment is present.
- [ ] All listed cases pass.

---

### Task 8: The reserve service and the capacity module (T043)

#### Objective
Apply an accepted reservation — request record, reservation row, ledger entry and program row — in
one transaction under the program lock, with the FX rate denormalised onto the reservation.

#### Files
- `src/capacity/application/reservation.projection.ts` — create. Renders the `Reservation` body.
- `src/capacity/application/reserve.service.ts` — create.
- `src/capacity/capacity.module.ts` — create. Wires api, application, infrastructure and fx.
- `test/integration/reserve-service.spec.ts` — create. **Write first.**

#### Implementation
1. `reservation.projection.ts` exports
   `toReservationBody(row: InvoiceReservationEntity): ReservationBody` producing exactly the
   contract's `Reservation`: `invoiceId`, `programId`, `status`, `invoiceAmount`
   (`{ amountMinor: invoiceAmountMinor.toString(), currency: invoiceCurrency }`), `reserved`
   (`{ amountMinor: reservedMinor.toString(), currency: programCurrency }`), `outstanding`
   (`{ invoice: {…outstandingInvoiceMinor, invoiceCurrency}, reserved: {…outstandingReservedMinor, programCurrency} }`),
   `fx` (`null` when `fxRate` is null, else `{ rate, effectiveAt: fxRateEffectiveAt.toISOString(), source: fxRateSource }`),
   and `createdAt: createdAt.toISOString()`.
2. `reserve.service.ts`:

```ts
export interface ReserveCommand {
  readonly organisationId: string;
  readonly programId: string;
  readonly requestId: string;      // the Idempotency-Key header
  readonly invoiceId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly actor: string;          // the organisation id; there is no user identity in the token
  readonly correlationId: string;
}

export interface ReserveOutcome {
  readonly created: boolean;       // true → 201, false → 200 replay
  readonly body: { reservation: ReservationBody; availability: AvailabilityBody };
}

@Injectable()
export class ReserveService {
  async reserve(command: ReserveCommand): Promise<ReserveOutcome>;
}
```

   `reserve` calls `unitOfWork.withProgramLock(command.programId, async ({ manager, program }) => …)`
   and inside, in this exact order:
   1. `const now = new Date();`
   2. `idempotency.begin(manager, identity, now)` where `identity.fingerprint` is
      `reserveFingerprint({ programId, invoiceId, amountMinor: amountMinor.toString(), currency })`
      and `operation` is `'RESERVE'`. On `refused` throw `new CapacityRefusal(code)`. On `replay`
      return `{ created: false, body: outcome as … }` — the stored outcome **is** the response body.
   3. Duplicate check: `SELECT 1 FROM invoice_reservation WHERE program_id = $1 AND invoice_id = $2`
      on `manager`. A hit throws `new CapacityRefusal('DUPLICATE_INVOICE')`. This is reliable because
      the program row is already locked.
   4. Resolve FX: when `command.currency === program.currency`, `fx = { kind: 'sameCurrency' }`;
      otherwise `const rate = await this.fxRateProvider.rateFor(command.currency, program.currency, now)`
      and `fx = rate === null ? { kind: 'unavailable' } : { kind: 'rate', rate }`.
   5. `const decision = decideReservation({ program: programRepository.toPosition(program), invoiceAmountMinor: command.amountMinor, fx });`
      On `refused`, increment `reservationOutcomesTotal.labels('refused', decision.code).inc()` and
      throw `new CapacityRefusal(decision.code, decision.details)`.
   6. Insert the reservation with `manager.query`, parameterised, returning the inserted row:
      `program_id`, `invoice_id`, `invoice_amount_minor` (`command.amountMinor`), `invoice_currency`
      (`command.currency`), `program_currency` (`program.currency`), `reserved_minor`
      (`decision.reservedMinor`), `outstanding_invoice_minor` (= `command.amountMinor`),
      `outstanding_reserved_minor` (= `decision.reservedMinor`), `fx_rate` / `fx_rate_effective_at` /
      `fx_rate_source` (all three `null` for `sameCurrency`, all three set otherwise),
      `status` `'ACTIVE'`, `origin` `'LOCAL'`, `treasury_acknowledged` `false`,
      `acknowledged_by_version` `null`, `treasury_reference` `null`, and `confirmed_at`,
      `created_at`, `updated_at` all `now`. All `bigint` values are bound as `.toString()`.
   7. `const result = advancePosition(programRepository.toPosition(program), [{ deltaMinor: decision.reservedMinor, component: 'LOCAL', cause: 'RESERVATION', originReference: command.invoiceId, actor: command.actor, correlationId: command.correlationId }], now);`
   8. `await programRepository.persistAdvance(manager, command.programId, result, now);`
   9. Build `body` from `toReservationBody(insertedRow)` and `toAvailabilityBody(programAfter, now)`,
      where `programAfter` is the locked `ProgramEntity` with the fields from `result.program`
      applied — build a new object, do not mutate the entity.
   10. `await idempotency.complete(manager, identity, body as unknown as Record<string, unknown>);`
   11. `reservationOutcomesTotal.labels('accepted', 'none').inc();` and return `{ created: true, body }`.

3. `src/capacity/capacity.module.ts` provides `UnitOfWork`, `ProgramRepository`, `LedgerRepository`,
   `IdempotencyService`, `ReserveService`, and `{ provide: FX_RATE_PROVIDER, useClass: CachedRateProvider }`.
   It declares the controller added in Task 10 and the filter added in Task 11. Add
   `CapacityModule` to `AppModule`'s `imports` array after `AuthModule`.

#### Constraints
- **One transaction.** Every statement uses the `manager` from `withProgramLock`. Never reach for
  `this.dataSource` inside the callback.
- **`persistAdvance` stays the only writer of the program row.** Do not `UPDATE program` directly.
- Do not catch `CapacityRefusal` inside the service — it must escape so the transaction rolls back.
- Do not mutate the `ProgramEntity` handed in by the unit of work.
- Do not log the token, the fingerprint, or another organisation's identifiers.
- The label values for `reservationOutcomesTotal` are `('accepted' | 'refused', reason)`; check the
  counter's declared label names in `src/observability/metrics.ts` and match them exactly.

#### Edge Cases
- **A replay returns the stored body verbatim**, including its `availability` snapshot from the
  original request. It is not recomputed — the contract's 200 is "the original outcome".
- `ProgramNotFoundError` from the unit of work: it cannot normally reach here, because
  `ProgramScopeGuard` already answered 404. Let it propagate; Task 11 maps it to `NOT_FOUND`.
- A reservation that pushes the program over its limit through a treasury-side change is impossible
  in this phase, but `advancePosition` may still append `OVER_LIMIT_ONSET`. Persist whatever it
  returns; do not filter entries.
- `command.amountMinor` equal to available: accepted (Task 5 decided this).

#### Verification
```bash
npx jest test/integration/reserve-service.spec.ts
```

Required integration cases, driving `ReserveService` directly against Testcontainers Postgres with
migrations applied and the seed data loaded:
- Same-currency reservation of `1_000_00n` USD against the Northwind USD program: returns
  `created: true`; `invoice_reservation` has one row with `fx_rate IS NULL`;
  `capacity_ledger_entry` has exactly one new row with `component = 'LOCAL'`, `cause = 'RESERVATION'`,
  `delta_minor = 100000`; `program.local_reserved_minor` is `100000`.
- Cross-currency: `1_000_000_00n` EUR against the Northwind **USD** program at the seeded
  `1.0850000000` stores `reserved_minor = 108500000`, and the reservation row carries
  `fx_rate = 1.0850000000`, a non-null `fx_rate_effective_at` and `fx_rate_source = 'seed'`.
- A second call with the same `Idempotency-Key` and identical content returns `created: false` and a
  byte-identical body, and leaves the ledger row count unchanged.
- A second call with the same key and a different amount throws `CapacityRefusal('IDEMPOTENCY_CONFLICT')`
  and leaves the ledger row count unchanged.
- A second reservation for the same `invoiceId` under a **different** key throws
  `CapacityRefusal('DUPLICATE_INVOICE')`.
- A reservation in a currency with no seeded rate (e.g. `GBP`) throws
  `CapacityRefusal('FX_RATE_UNAVAILABLE')` and writes nothing — assert the ledger and
  `request_record` row counts are unchanged, proving the rollback.
- After any refusal, the same `Idempotency-Key` can be used again successfully — the `PENDING` row
  did not survive.

#### Completion Criteria
- [ ] `ReserveService.reserve` follows the eleven steps in order.
- [ ] `CapacityModule` exists and is imported by `AppModule`.
- [ ] The FX rate, effective time and source are on the reservation row for cross-currency only.
- [ ] All seven integration cases pass.

---

### Task 9: The create-reservation DTO and the shared validation pipe (T044)

#### Objective
Reject a malformed body at the boundary with `VALIDATION_FAILED`, including amounts that match the
contract's pattern but overflow `BIGINT`.

#### Files
- `src/shared/validation/create-validation-pipe.ts` — create.
- `src/main.ts` — modify to use it.
- `src/capacity/api/dto/money.dto.ts` — create.
- `src/capacity/api/dto/create-reservation.dto.ts` — create.
- `test/unit/create-reservation-dto.spec.ts` — create. **Write first.**

#### Implementation
1. `create-validation-pipe.ts` exports
   `export const createValidationPipe = (): ValidationPipe => new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });`
   `main.ts` replaces its inline `new ValidationPipe({…})` with `createValidationPipe()`. The options
   must not change.
2. `money.dto.ts`:

```ts
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

@ValidatorConstraint({ name: 'fitsInt64', async: false })
export class FitsInt64 implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string' || !/^-?[0-9]{1,19}$/.test(value)) return false;
    const parsed = BigInt(value);
    return parsed >= INT64_MIN && parsed <= INT64_MAX;
  }
  defaultMessage(): string {
    return 'amountMinor must be an integer that fits a signed 64-bit value';
  }
}

export class MoneyDto {
  @IsString()
  @Matches(/^-?[0-9]{1,19}$/, { message: 'amountMinor must be an integer string' })
  @Validate(FitsInt64)
  amountMinor!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO-4217 alphabetic code' })
  currency!: string;
}
```

   The 19-digit pattern alone admits `9999999999999999999`, which is larger than `INT64_MAX`; the
   `FitsInt64` constraint is what actually protects the `BIGINT` column.
3. `create-reservation.dto.ts`:

```ts
export class CreateReservationDto {
  @IsString()
  @Length(1, 128)
  invoiceId!: string;

  @ValidateNested()
  @Type(() => MoneyDto)
  @IsObject()
  amount!: MoneyDto;
}
```

#### Constraints
- Keep `amountMinor` a **string** through validation. Do not add `@Transform` to a `number` or a
  `bigint` — `transform: true` plus a numeric type would route the value through `Number` and
  silently corrupt large amounts.
- Do not relax `forbidNonWhitelisted`; an unknown property must be a 400, not ignored.
- Do not validate the amount's **sign or magnitude against the program** here. That is the policy's
  job, and the DTO has no program.

#### Edge Cases
- **Zero and negative amounts are a client error, not a capacity refusal.** `MoneyDto` keeps the
  contract's signed pattern, because releases in a later phase reuse it. `CreateReservationDto` uses
  a subclass instead:

```ts
export class PositiveMoneyDto extends MoneyDto {
  @IsString()
  @Matches(/^[1-9][0-9]{0,18}$/, { message: 'amountMinor must be a positive integer string' })
  @Validate(FitsInt64)
  override amountMinor!: string;
}
```

  and declares `amount!: PositiveMoneyDto` with `@Type(() => PositiveMoneyDto)`. A reservation of
  `'0'` or `'-5'` is therefore a 400, never a 409.
- `invoiceId` of exactly 128 characters passes; 129 fails.
- A missing `amount` object fails with a nested path (`amount`), not a crash.

#### Verification
```bash
npx jest test/unit/create-reservation-dto.spec.ts
```

Required cases, using `plainToInstance` + `validate` from `class-transformer` / `class-validator`
directly (no HTTP):
- A well-formed body passes with zero errors.
- `amountMinor: '9999999999999999999'` (19 nines, above `INT64_MAX`) fails.
- `amountMinor: '9223372036854775807'` (`INT64_MAX`) passes.
- `amountMinor: '0'` and `'-5'` fail.
- `amountMinor: 100` (a JSON number) fails.
- `currency: 'usd'` fails; `'USD'` passes.
- `invoiceId` of 129 characters fails.
- An extra unknown property is rejected under `forbidNonWhitelisted`.

#### Completion Criteria
- [ ] Both DTO files exist with the constraints above.
- [ ] `main.ts` uses `createValidationPipe()`.
- [ ] All eight cases pass.

---

### Task 10: The POST endpoint and throttle scoping (T045, carry-over B)

#### Objective
Expose the reservation route with the right scope, a required `Idempotency-Key`, 201/200 semantics,
and a throttle budget that is the `write` budget alone.

#### Files
- `src/capacity/api/capacity.controller.ts` — create.
- `src/capacity/capacity.module.ts` — modify to declare the controller.
- `test/integration/reserve-endpoint.spec.ts` — create. **Write first.**

#### Implementation

```ts
@Controller('v1/programs/:programId/reservations')
// Two named throttlers are registered globally ('read' 600/min, 'write' 120/min) and
// @nestjs/throttler applies EVERY named throttler to EVERY route unless the route opts
// out. Without this line a write would also consume the read budget, and the effective
// limit on every route would silently be the tighter of the two.
@SkipThrottle({ read: true })
export class CapacityController {
  constructor(private readonly reserveService: ReserveService) {}

  @Post()
  @RequiredScope('capacity:write')
  async createReservation(
    @Param('programId', new ParseUUIDPipe({ version: '4' })) programId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateReservationDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReservationResponseBody> { … }
}
```

   Body:
   1. Validate the header: missing, shorter than 8 or longer than 128 characters →
      `throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Idempotency-Key is required.', details: { 'Idempotency-Key': 'required, 8 to 128 characters' } })`.
      The contract marks the header `required` with `minLength: 8, maxLength: 128`.
   2. Build the command: `organisationId` from `request.auth.org`, `actor` also from
      `request.auth.org`, `correlationId` from `currentCorrelationId()` in `src/shared/correlation`,
      `amountMinor: BigInt(dto.amount.amountMinor)`, `currency: dto.amount.currency`.
   3. `const outcome = await this.reserveService.reserve(command);`
   4. `response.status(outcome.created ? 201 : 200);` and return `outcome.body`.

   The route parameter **must** be named `programId` — `ProgramScopeGuard` resolves ownership only
   for that exact name, and any other name silently disables the ownership check.
   `RequiredScope` is imported from `../../shared/scope`, not from `src/auth` (Task 2).

#### Constraints
- Do not register a second `ValidationPipe` on the controller; the global one from Task 9 applies.
- Do not add the `GET` routes. They are Phase 5.
- Do not catch `CapacityRefusal` here; Task 11's filter maps it.
- Do not set `@Throttle` overrides with numeric limits — the budgets come from configuration.

#### Edge Cases
- A non-UUID `programId`: `ProgramScopeGuard` already answers 404 before the pipe runs. Keep
  `ParseUUIDPipe` anyway as defence in depth; if it ever fires, the filter maps it to 400.
- `Idempotency-Key` present twice in the request: Express collapses repeated headers into a
  comma-joined string, which fails the length check or the fingerprint comparison. No extra handling.
- A replay returns 200 with the identical body and **no** `Location` header. Do not add one.

#### Verification
```bash
npx jest test/integration/reserve-endpoint.spec.ts
```

Required cases, booting the real `AppModule` wiring over Testcontainers Postgres + Redis, with the
seed applied and tokens minted as `test/integration/auth.spec.ts` does:
- 201 with a `reservation` and an `availability` object on first call; the `availability.available`
  reflects the reservation immediately (FR-007b).
- The identical call with the same key → **200**, identical body.
- A token without `capacity:write` → 403 `INSUFFICIENT_SCOPE`.
- Northwind's token against Contoso's program id → 404 `NOT_FOUND` (not 403).
- Missing `Idempotency-Key` → 400 `VALIDATION_FAILED`.
- 121 rapid writes by one organisation → the 121st is 429 with a `Retry-After` header, proving the
  `write` budget applies.
- 601 reads are **not** required here; instead assert that a single write increments only the write
  budget, by issuing 100 writes and then confirming a further write still succeeds under a read
  limit of 600 — that is, the route is not capped at the read limit.

#### Completion Criteria
- [ ] The route exists at `POST /v1/programs/:programId/reservations` with `@RequiredScope('capacity:write')`.
- [ ] `@SkipThrottle({ read: true })` is present with the explanatory comment.
- [ ] 201 on create, 200 on replay.
- [ ] All listed cases pass.

---

### Task 11: The error filter (T046)

#### Objective
Map every typed outcome to the exact code and status in `contracts/errors.md`, with a body that
leaks nothing.

#### Files
- `src/capacity/api/error.filter.ts` — create.
- `src/capacity/capacity.module.ts` — modify to register it as `APP_FILTER`.
- `test/unit/error-filter.spec.ts` — create. **Write first.**

#### Implementation
`@Catch()` (everything), implementing `ExceptionFilter`. Resolution order:

1. `CapacityRefusal` → status from this table, body `{ code, message, correlationId, details? }`:

| code | status |
|---|---|
| `INSUFFICIENT_CAPACITY` | 409 |
| `PROGRAM_OVER_LIMIT` | 409 |
| `DUPLICATE_INVOICE` | 409 |
| `IDEMPOTENCY_CONFLICT` | 409 |
| `IDEMPOTENCY_EXPIRED` | 409 |
| `REQUEST_IN_FLIGHT` | 409 |
| `FX_RATE_UNAVAILABLE` | 409 |
| `AMOUNT_ROUNDS_TO_ZERO` | 409 |
| `POSITION_UNVERIFIED` | **503** |

   Messages are fixed, human-readable strings held in one `const MESSAGES: Record<RefusalCode, string>`
   map in this file. They must not interpolate an amount, an identifier, or a program id.
2. `ProgramNotFoundError` (from `infrastructure/unit-of-work.ts`) → 404 `NOT_FOUND`, message
   `'Program not found.'`.
3. `HttpException` whose response body is already an object carrying a `code` string — the guards
   throw exactly this shape — → pass through with its own status, adding `correlationId` if absent.
   Do not rewrite its `code`.
4. `BadRequestException` from the `ValidationPipe` → 400 `VALIDATION_FAILED`. Its response
   `message` is a `string[]` of constraint messages; convert to `details` by taking, for each entry,
   the first token that looks like a property path (the class-validator default message begins with
   the property name) as the key and the whole message as the value. Cap `details` at 20 entries.
5. Anything else → 500, body `{ code: 'INTERNAL', message: 'An unexpected error occurred.', correlationId }`,
   and log the original error with its stack through the Nest `Logger` at `error` level. The stack
   goes to the log, never to the response.

`correlationId` comes from `currentCorrelationId()` in `src/shared/correlation`.

#### Constraints
- **The response body may never contain a `stack`, `sql` or `query` key**, at any nesting depth. The
  contract test fails the build if one appears. Build `details` by explicit assignment only — never
  spread a driver error or an exception object into it.
- Never include another organisation's identifiers. `details` carries field paths and reasons only.
- Do not swallow the 500 log. A silent 500 is worse than a noisy one.

#### Edge Cases
- A `CapacityRefusal` with no `details`: omit the key entirely rather than emitting `details: {}` —
  `Error` requires only `code`, `message`, `correlationId`.
- A `QueryFailedError` carrying SQLSTATE `23505` on `invoice_reservation_program_invoice_unique`
  (the backstop firing): map to 409 `DUPLICATE_INVOICE`, and **do not** copy the driver message into
  the response.
- An exception thrown before the correlation middleware ran: `currentCorrelationId()` must still
  return a string. If it can return `undefined`, substitute `'unknown'`.

#### Verification
```bash
npx jest test/unit/error-filter.spec.ts
```

Required cases, invoking the filter directly with a stubbed `ArgumentsHost`:
- Each of the nine `RefusalCode` values produces its tabled status and its `code`.
- `POSITION_UNVERIFIED` produces **503**, not 409.
- A `ProgramNotFoundError` produces 404 `NOT_FOUND`.
- A guard-style `ForbiddenException({ code: 'INSUFFICIENT_SCOPE', … })` passes through as 403 with
  its original code.
- A `ValidationPipe` `BadRequestException` with `message: ['invoiceId must be shorter than…']`
  produces 400 `VALIDATION_FAILED` with an `invoiceId` key in `details`.
- A raw `Error('boom')` produces 500 `INTERNAL`, and the serialised body contains no `stack`, `sql`
  or `query` key — assert with `JSON.stringify(body)` and a substring check on all three.

#### Completion Criteria
- [ ] The filter is registered via `APP_FILTER` in `CapacityModule`.
- [ ] Every code in the table maps to its listed status.
- [ ] The 500 path logs the stack and returns none of it.
- [ ] All listed cases pass.

---

### Task 12: The contract test (T038)

#### Objective
Prove the endpoint's responses conform to `contracts/http-api.yaml`, including that `amountMinor` is
a string and that 429 and 503 are reachable.

#### Files
- `package.json` — modify. Add devDependencies `js-yaml@5.4.2`, `ajv@8.20.0`, `ajv-formats@3.0.1`.
- `test/contract/reservations.contract.spec.ts` — create.
- `test/support/openapi.ts` — create. Loads the YAML and compiles validators.

#### Implementation
1. Install exactly:

```bash
npm install --save-dev --save-exact js-yaml@5.4.2 ajv@8.20.0 ajv-formats@3.0.1
```

   `js-yaml` v5 ships its own TypeScript types and a CommonJS entry point, so **do not** add
   `@types/js-yaml`.
2. `test/support/openapi.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

export function openapiValidator(schemaRef: string) { … }
```

   It reads `specs/001-program-capacity-reservation/contracts/http-api.yaml`, `load`s it, registers
   the **whole document** with Ajv under a base id so internal `$ref`s such as
   `#/components/schemas/Money` resolve, applies `addFormats`, and returns
   `ajv.getSchema(schemaRef)`. OpenAPI 3.1 schemas are JSON Schema 2020-12, which is why the 2020
   dialect import is required — the default `ajv` export would reject them.
3. The spec boots the app as Task 10's test does and asserts:
   - The 201 body validates against `#/components/schemas/ReservationResponse`.
   - `typeof body.reservation.reserved.amountMinor === 'string'` **and** the raw response text
     contains `"amountMinor":"` — proving the number never crossed the wire unquoted.
   - The 200 replay body validates against the same schema.
   - A 409 body validates against `#/components/schemas/Error`.
   - **429 is reachable**: exceed the write budget and validate the body against `Error` with
     `code === 'RATE_LIMITED'` and a `Retry-After` header present.
   - **503 is reachable**: set `position_verified = FALSE` on the program directly, then attempt a
     reservation, and validate a 503 body with `code === 'POSITION_UNVERIFIED'`.
   - No error body contains a `stack`, `sql` or `query` key at any depth.

#### Constraints
- Do not edit `contracts/http-api.yaml` to make a test pass. If the implementation disagrees with the
  contract, the implementation is wrong.
- Do not add a runtime OpenAPI dependency to `dependencies`; these are test-only.
- Do not use `@nestjs/swagger` to generate a spec and compare — the YAML is the source of truth.

#### Edge Cases
- Ajv rejects unknown OpenAPI keywords such as `example` or `discriminator`; construct Ajv with
  `strict: false` so document-level annotations do not fail compilation.
- `format: uuid` and `format: date-time` require `ajv-formats`; without it they are ignored silently
  and the test proves less than it appears to.

#### Completion Criteria
- [ ] The three devDependencies are pinned exactly as listed.
- [ ] The contract test validates 201, 200, 409, 429 and 503 bodies against the YAML.
- [ ] The `amountMinor`-is-a-string assertion checks the raw response text.
- [ ] `npx jest test/contract` passes.

---

### Task 13: The concurrency test (T035)

#### Objective
Demonstrate, with real parallel transactions, that 1,000 concurrent reservations never breach the
limit, that the ledger reconciles to the cached position, and that nothing fails for contention
alone.

#### Files
- `test/integration/concurrency.spec.ts` — create.

#### Implementation
1. Boot Testcontainers Postgres, run migrations, and insert **one** organisation and **one** program
   directly: currency `USD`, `credit_limit_minor = 100_000n` (1,000.00 USD), all reserved figures
   zero, `next_sequence = 1`, `position_verified = TRUE`.
2. Build the Nest application once, over a `DataSource` whose pool is large enough not to be the
   bottleneck: `extra: { max: 50 }`.
3. Fire **1,000** concurrent `POST` requests through `supertest`, each with a distinct `invoiceId`
   and a distinct `Idempotency-Key`, each reserving `1_000n` minor units (10.00 USD). The limit
   admits exactly 100 of them.
4. Assert:
   - Exactly **100** responses are 201.
   - Every other response is **409 `INSUFFICIENT_CAPACITY`**. No response is 500, and no response is
     a serialization or deadlock failure — assert on the set of observed status codes being exactly
     `{201, 409}` (SC-003a: no request fails for contention alone).
   - `SELECT local_reserved_minor FROM program` is exactly `100000`, never more.
   - `SELECT COALESCE(SUM(delta_minor),0) FROM capacity_ledger_entry WHERE program_id = $1 AND component = 'LOCAL'`
     equals `local_reserved_minor` — the ledger is the authority and the cache agrees (SC-004).
   - `SELECT COUNT(*) FROM invoice_reservation` is exactly 100.
   - The ledger's `sequence` values for the program are gapless from 1 to the row count.
5. Set `jest.setTimeout(300_000)`.

#### Constraints
- **No mocked repository.** tasks.md is explicit: a mock cannot demonstrate this. Everything runs
  through the real service against a real database.
- Do not lower the request count to make the test faster. 1,000 is the figure SC-001 states.
- Do not retry a failed request inside the test — a retry would hide exactly the failure mode being
  measured.
- Do not assert wall-clock latency. SC-003a's timing bound is a load-test concern, not a CI one;
  this test asserts the **absence of contention failures**, not the p95.

#### Edge Cases
- Connection-pool exhaustion masquerading as contention: fix it with the pool size in step 2, and if
  a `TimeoutError` still appears, that is a genuine failure to report, not a flake to retry.
- A 429 from the throttler would corrupt the result. Override `ThrottlerStorage` in the testing
  module with an in-memory stub that never throttles, exactly as `test/integration/auth.spec.ts`
  does, or set both limits high enough that 1,000 requests pass.

#### Verification
```bash
npx jest test/integration/concurrency.spec.ts
```

Expected: passes. Run it **three times in a row** and confirm it passes each time — a flaky result
here is a real defect in the locking, not test noise.

#### Completion Criteria
- [ ] 1,000 concurrent requests, exactly 100 accepted.
- [ ] Observed status codes are exactly `{201, 409}`.
- [ ] Ledger sum equals the cached position, sequences gapless.
- [ ] Three consecutive clean runs.

---

### Task 14: The currency-mismatch test (T036, reservation half)

#### Objective
Prove a reservation in a currency with no rate is refused `FX_RATE_UNAVAILABLE` and applies nothing.

#### Files
- `test/integration/currency-mismatch.spec.ts` — create.
- `specs/001-program-capacity-reservation/tasks.md` — modify T036 to record the split.

#### Implementation
1. The test, against Testcontainers Postgres with the seed applied:
   - A `GBP` reservation against the Northwind **USD** program → 409 `FX_RATE_UNAVAILABLE`; assert
     `capacity_ledger_entry`, `invoice_reservation` and `request_record` row counts are all
     unchanged.
   - A `EUR` reservation against the same program → 201, with `fx.rate === '1.0850000000'` on the
     reservation body, proving the refusal above is about the missing rate and not about
     cross-currency reservations generally.
   - A rate that exists but is dated **after** `now` is not selected: insert
     `('GBP','USD', now + 1 day, '1.2700000000','test')` and confirm the `GBP` reservation still
     refuses `FX_RATE_UNAVAILABLE`.
   - The 1-unit rounding case: insert a `JPY→USD` rate of `0.0067`, reserve `1` JPY, and assert 409
     `AMOUNT_ROUNDS_TO_ZERO` — a distinct code from `FX_RATE_UNAVAILABLE`.
2. T036 as written also requires that *a treasury message* asserting a foreign currency is
   quarantined `CURRENCY_MISMATCH`. **No Kafka consumer exists until Phase 7**, so that half cannot
   be written now. In `tasks.md`, replace T036's text with the reservation half and add a new
   `- [ ] T036a [US5] …` line under Phase 7's test section carrying the quarantine half verbatim,
   plus a one-sentence note saying it was moved because the consumer arrives in that phase.

#### Constraints
- Do not stub `FxRateProvider` in this test. The point is the real `CachedRateProvider` against the
  real `fx_rate` table.
- Do not implement any part of the Kafka consumer to satisfy the moved half.
- Do not delete T036; it is renumbered, not dropped, so the coverage trace stays intact.

#### Edge Cases
- `CachedRateProvider`'s 60-second cache could serve a stale `null`. The plan specifies that nulls
  are **not** cached (Task 4), so inserting a rate mid-test is visible immediately. If it is not,
  Task 4 was implemented wrongly.
- The seeded rates use `effective_at = new Date(0)`; a test inserting a newer rate for the same pair
  must use a distinct `effective_at` or it collides with the primary key.

#### Verification
```bash
npx jest test/integration/currency-mismatch.spec.ts
```

Expected: all four cases pass, and `tasks.md` shows T036 reduced and T036a added under Phase 7.

#### Completion Criteria
- [ ] The four cases pass.
- [ ] `tasks.md` records the split with its reason.
- [ ] No Kafka code was written.

---

## Final Verification

1. Bring the stack up and apply migrations and seed from a clean volume.
2. Run the full gate exactly as CI does.
3. Exercise the endpoint by hand once, to confirm the local run works end to end.

```bash
docker compose down -v && docker compose up -d
DATABASE_URL=postgres://capacity:capacity_local_dev@localhost:5432/capacity npm run migration:run
DATABASE_URL=postgres://capacity:capacity_local_dev@localhost:5432/capacity JWT_SECRET=local-development-secret-0123456789abcdef npm run seed
npm run lint
npm run typecheck
npm test
npm run test:cov
npm run build
```

Expected:
- Lint reports no `boundaries/dependencies` violation. A violation here means Task 2's matrix change
  was wrong or a layer imported something it must not.
- `npm test` passes, including `test/contract` and every `test/integration` spec.
- `npm run test:cov` passes the 80% global threshold. **Never lower `coverageThreshold` in
  `jest.config.ts` to make this pass** — it is the Constitution VI merge gate. If coverage falls
  short, the missing tests are the defect.
- `npm run build` succeeds.

Manual check, using a token printed by the seed:

```bash
curl -i -X POST http://localhost:3000/v1/programs/b1b2c3d4-0001-4000-8000-000000000011/reservations \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: manual-check-0001" \
  -H "Content-Type: application/json" \
  -d '{"invoiceId":"INV-0001","amount":{"amountMinor":"100000","currency":"USD"}}'
```

Expected: `201`, a body carrying `reservation` and `availability`, with
`availability.available.amountMinor` reduced by `100000`. Repeating the identical command returns
`200` with the identical body. Changing only the amount under the same key returns `409`
`IDEMPOTENCY_CONFLICT`.

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

The executor may stop only for a concrete blocker such as:

- a referenced file, API, dependency, or subsystem does not exist;
- repository state materially contradicts facts the plan depends on;
- a required credential or external resource is unavailable;
- the prescribed implementation is technically impossible;
- executing the plan would require making an architectural or product decision not covered by the
  plan;
- two instructions in the plan directly contradict each other;
- verification proves that an assumption fundamental to the planned implementation is false.

When stopping, the executor must report: the task number, the exact blocker, the evidence
establishing it, which plan assumption is invalid, and the minimum planning decision required to
continue.

The executor must **not** propose or implement an alternative unless explicitly asked to re-plan.
