# Execution Plan: Report treasury stream lag and measure SC-002a end to end

## Goal

`GET /programs/{programId}/availability` reports a real `treasury.lagSeconds` — the distance
between the newest treasury message this service has **applied** for a program and the newest
message **available** for it on the stream — so FR-007a and FR-007c are met instead of permanently
deferred. The SC-002a performance gate measures that latency through the actual broker rather than
bypassing it.

## Current State

- **`lagSeconds` is hardcoded `null`.** `src/capacity/application/availability.projection.ts:73`
  returns `lagSeconds: null`, with a comment at `:70-72` saying no component knows the stream head.
  Asserted null by `test/unit/availability-projection.spec.ts:59,66` and
  `test/contract/availability.contract.spec.ts:191`.
- **The contract permits null.** `contracts/http-api.yaml:409` types it `[number, 'null']` with
  `minimum: 0`; it is in `treasury.required` (`:401`). The stale "not yet knowable" claim lives in
  a YAML **comment** at `:406-408` — the `lagSeconds` node has **no `description` key** — and in
  the object description at `:402`. A third reference sits at `:29`.
- **The spec requirement was never amended.** FR-007a (`spec.md:293-295`) requires the response to
  report "the current lag between that effective time and the newest message available on the
  stream". FR-007c (`spec.md:299-301`) requires reporting the lag rather than concealing it. Both
  are unmet.
- **`treasury_effective_at` is written by the snapshot path only.** The sole writer is
  `src/capacity/application/apply-snapshot.service.ts:266`. The capacity-event path goes through
  `ProgramRepository.persistAdvance`
  (`src/capacity/infrastructure/repositories/program.repository.ts:70-87`), whose `UPDATE program`
  sets only `credit_limit_minor`, `local_reserved_minor`, `treasury_reserved_minor`,
  `next_sequence`, `over_limit_since` and `position_changed_at`. Event versions are recorded in
  `processed_message` (`apply-treasury-event.service.ts:127-134`) and in the reservation's
  `acknowledged_by_version` (`:158-165`), never on the program.

  **Consequence, and the reason this plan adds a column:** a lag measured against
  `treasury_effective_at` would grow continuously during normal healthy operation, because the
  stream head advances on every event while that column advances only on a snapshot. That is the
  same defect Key Decision 2 rejects, reached from a different direction.
- **Both treasury payloads carry `programId` and `effectiveAt`.**
  `src/treasury/schemas/capacity-event.schema.ts:193-232` and
  `src/treasury/schemas/reconciliation-snapshot.schema.ts:253-274` both require a UUID `programId`
  and a date-time `effectiveAt`.
- **Program plumbing.** Column list and mapping: `src/capacity/infrastructure/unit-of-work.ts:24-50`
  (`ProgramRow` and `toProgramEntity`); entity fields at
  `src/capacity/infrastructure/entities/program.entity.ts:30-34`.
- **No test uses a Kafka broker.** `test/support/` holds only `openapi.ts`,
  `postgres-container.ts`, `redis-container.ts`, `treasury.ts`. `@testcontainers/redpanda@12.1.0`
  is a devDependency (`package.json:58`) and unused.
- **`RedpandaContainer` cannot do SASL.** In `node_modules/@testcontainers/redpanda@12.1.0`,
  `build/redpanda-container.d.ts` exposes only `getBootstrapServers()`,
  `getSchemaRegistryAddress()`, `getAdminAddress()`, `getRestProxyAddress()`;
  `build/assets/redpanda.yaml.hbs` sets `authentication_method: none` on both kafka_api listeners
  and `build/assets/bootstrap.yaml` sets `kafka_enable_authorization: false`, both rendered
  unconditionally. The constructor **requires** an image string with no default.
- **`TreasuryConsumer` refuses to start under test.** `src/treasury/consumer/treasury.consumer.ts:101-104`
  returns from `onModuleInit` when `NODE_ENV === 'test'`; asserted by
  `test/unit/treasury-consumer.spec.ts:179`. Jest sets `NODE_ENV=test`. `NODE_ENV` is read in `src`
  only there, at `src/config/env.schema.ts:4` (which allows `'development'`) and at
  `src/treasury/kafka.config.ts:18` (`ssl`).
- **Module direction is Treasury → Capacity.** `src/treasury/treasury.module.ts:14` is
  `imports: [CapacityModule]`, so `CapacityModule` cannot import `TreasuryModule`.
  `src/app.module.ts` has no `providers` array.
- **`toAvailabilityBody` has four production call sites**: `availability.service.ts:31`,
  `reserve.service.ts:224`, `release.service.ts:222`, `cancel.service.ts:203`. There are **no unit
  specs** for `ReserveService`, `ReleaseService` or `CancelService`; the manual construction sites
  are `test/integration/reserve-service.spec.ts:136`, `test/integration/over-limit.spec.ts:81`
  (Reserve) and `:87` (Release), and `test/integration/limit-reduction.spec.ts:81` (Release).
  `CancelService` is never constructed manually. `test/unit/availability-projection.spec.ts` calls
  `toAvailabilityBody` at lines 26, 37, 54, 59, 64, 66, 72, 73 and 79.
- **SC-002a bypasses the broker.** `test/performance/sc-002a-treasury-visibility.spec.ts` calls
  `harness.applyService.apply(...)` directly, asserts `p99 <= 5_000` over 25 iterations, builds
  from `AppModule` (`:137-140`), seeds `treasuryVersion: 0` (`:128`), uses `version: index + 1`
  (`:85`) and `effectiveAt: Date.UTC(2026, 0, 1, 0, 0, index)` (`:86-88`), polls
  `reserved.treasury.amountMinor` (`:204-210`), sets env at `:107-113`, restores it at `:170-176`,
  and tears down with `app.get(ThrottlerStorage)` → `storage.redis.disconnect()` at `:159-166`.
- **Boundary policy** (`eslint.config.mjs`): `application` may import `domain`, `infrastructure`,
  `shared`, `fx`, `config`, `observability` — **not** `treasury`. `treasury` may import
  `application`, `shared`, `config`, `observability`. `shared` may import `shared`, `config`.
  External packages are not boundary elements, so `@nestjs/common` is importable from `shared`
  (`src/shared/correlation/correlation.middleware.ts:2` already does and lints clean).

## Target State

- `program.treasury_applied_effective_at` records the effective time of the newest treasury
  message actually applied to a program, written by **both** the event and snapshot apply paths.
- A `StreamLagRegistry` in `src/shared/stream-lag/` holds, per program id, the newest
  `effectiveAt` observed on either treasury topic.
- A lag probe consumer in `src/treasury/` runs in its own consumer group, reads both topics from
  the latest offset, extracts `programId` and `effectiveAt`, records them, and never commits an
  offset or applies anything.
- `toAvailabilityBody` computes `lagSeconds` as the whole seconds between
  `treasury_applied_effective_at` and the newest observed effective time for that same program.
  Both operands are business effective times for one program, so the difference is meaningful and
  is zero for a caught-up program.
- A Redpanda testcontainer harness exists and backs a lag integration spec and the rewritten
  SC-002a gate, which publishes to the real topic and measures until the change is visible through
  `GET /availability`.
- `docs/ASSUMPTIONS.md` no longer claims the lag is unknowable; research R11 records the local
  plaintext-listener deviation.

## Scope

### In Scope

- `src/migrations/1758270000000-AddTreasuryAppliedEffectiveAt.ts` — new.
- `src/capacity/infrastructure/entities/program.entity.ts`,
  `src/capacity/infrastructure/unit-of-work.ts` — the new column.
- `src/capacity/application/apply-treasury-event.service.ts`,
  `src/capacity/application/apply-snapshot.service.ts` — write the new column.
- `specs/001-program-capacity-reservation/data-model.md` — document the column.
- `src/shared/stream-lag/stream-lag.registry.ts`, `src/shared/stream-lag/index.ts` — new.
- `src/treasury/consumer/stream-lag.probe.ts` — new.
- `src/capacity/capacity.module.ts`, `src/treasury/treasury.module.ts` — provider wiring.
- `src/treasury/kafka.config.ts`, `src/config/env.schema.ts`, `.env.example` — SASL switch and two
  new keys.
- `src/capacity/application/availability.projection.ts`, `availability.service.ts`,
  `reserve.service.ts`, `release.service.ts`, `cancel.service.ts` — compute and supply the lag.
- `specs/001-program-capacity-reservation/contracts/http-api.yaml` — the `lagSeconds` description.
- `test/support/redpanda-container.ts`, `test/integration/stream-lag.spec.ts`,
  `test/unit/stream-lag-registry.spec.ts` — new.
- Updated: `test/migration/migration.spec.ts`, `test/unit/availability-projection.spec.ts`,
  `test/contract/availability.contract.spec.ts`, `test/unit/kafka-config.spec.ts`,
  `test/integration/reserve-service.spec.ts`, `test/integration/over-limit.spec.ts`,
  `test/integration/limit-reduction.spec.ts`,
  `test/performance/sc-002a-treasury-visibility.spec.ts`.
- `docs/ASSUMPTIONS.md`, `specs/001-program-capacity-reservation/research.md`.

### Out of Scope

- Changing what `treasury.appliedVersion` or `treasury.effectiveAt` mean. Both continue to describe
  the last applied **snapshot**; the new column is separate and is not exposed as its own response
  field.
- Making the capacity-event path advance `treasury_version`.
- Persisting the stream head, or seeding the registry from history at startup.
- Enabling TLS on the local compose listener; R11 gets a recorded deviation.
- Rewriting SC-003 or SC-003a.
- Changing the `NODE_ENV === 'test'` guard in `treasury.consumer.ts`.

## Key Decisions

1. **A new column, `treasury_applied_effective_at`, is the lag basis.** `treasury_effective_at`
   cannot serve: it advances only on snapshots, so a lag against it grows during normal operation.
   Making the event path write `treasury_effective_at` instead was rejected because it would
   redefine `appliedVersion`/`effectiveAt` — ratified contract fields — from "last snapshot" to
   "last message of any kind". A separate column leaves both meanings intact. The column is
   internal: it is not added to the `Availability` schema.
2. **The registry is keyed by program id and stores the payload's `effectiveAt`.** A global stream
   head compared against a per-program applied time would make an idle program's lag grow while
   other programs' messages flow. And the Kafka record timestamp is a produce-time wall clock while
   `effectiveAt` is business time — subtracting one from the other is meaningless. Both operands
   are therefore payload effective times for the same program.
3. **Lag is measured by a probe consumer, not by offset arithmetic.** `admin.fetchTopicOffsets`
   returns offsets, not timestamps; it can say the consumer is behind but not by how many seconds.
4. **The probe is a separate consumer group and applies nothing.** Group id
   `${KAFKA_CONSUMER_GROUP_ID}-lag-probe`; sharing the processing group would steal its partitions.
   It never commits, never touches the database, never calls a handler. That independence is the
   point: when the processing consumer stalls, the probe keeps observing and the lag grows.
5. **The probe parses two fields and validates nothing else.** It reads `programId` and
   `effectiveAt` from the JSON body and deliberately does **not** run the schema validators in
   `src/treasury/schemas/` — a message that fails validation is still evidence the stream moved,
   and the probe must never make a quarantine decision. Anything unparseable is skipped.
6. **The registry is in-memory and per-process.** Every process serving reads also runs the probe.
   A process with no observation for a program reports `null`, which the contract permits.
7. **No history seeding at startup.** The probe subscribes with `fromBeginning: false`, so a fresh
   process reports `null` for a program until a message for it arrives. Recorded in
   `docs/ASSUMPTIONS.md`.
8. **`lagSeconds = max(0, floor((newestObservedEffectiveAt − treasuryAppliedEffectiveAt) / 1000))`,**
   and `null` when there is no observation for the program or the applied effective time is null.
   The zero clamp means a program at or ahead of the observed head reports 0, never a negative.
9. **`StreamLagRegistry` is provided and exported by `CapacityModule`.** `TreasuryModule` already
   imports `CapacityModule`, so the probe receives the same instance. Providing it in
   `TreasuryModule` would require the reverse import (circular); registering it in `AppModule`
   would not work, because that module has no `providers` array and `AvailabilityService` resolves
   inside `CapacityModule`'s injector.
10. **The test broker runs without SASL, via an explicit switch.** `RedpandaContainer` 12.1.0
    cannot enable SASL while `buildKafkaConfig` always sets a SCRAM block with `getOrThrow`
    credentials. `KAFKA_SASL_DISABLED`, defaulting to `'false'`, omits the block. Compose and
    production are unaffected.
11. **SC-002a keeps its 5-second p99 and its 25 iterations.** Only the measurement path changes. The
    budget is not relaxed for broker latency — if the real path cannot make 5 seconds, that is the
    finding SC-002a exists to produce.

## Execution Order

### Task 1: Add the `treasury_applied_effective_at` column

#### Objective

The program row can record the effective time of the newest treasury message applied to it,
independently of the snapshot-only `treasury_effective_at`.

#### Files

- `src/migrations/1758270000000-AddTreasuryAppliedEffectiveAt.ts` — created.
- `src/capacity/infrastructure/entities/program.entity.ts` — new field.
- `src/capacity/infrastructure/unit-of-work.ts` — `ProgramRow` and `toProgramEntity`.
- `specs/001-program-capacity-reservation/data-model.md` — document the column.
- `test/migration/migration.spec.ts` — one added case.

#### Implementation

1. Create the migration class `AddTreasuryAppliedEffectiveAt1758270000000` with
   `name = 'AddTreasuryAppliedEffectiveAt1758270000000'`, following the structure of
   `src/migrations/1758250000000-AddExpiredRequestState.ts`:

   - `up`: `ALTER TABLE program ADD COLUMN treasury_applied_effective_at TIMESTAMPTZ NULL;`
   - `down`: `ALTER TABLE program DROP COLUMN treasury_applied_effective_at;`

   Nullable with no default and no backfill: an existing program has no known applied effective
   time, and inventing one would report a fabricated lag. Null means "not knowable", exactly as
   the projection already treats it.

2. In `program.entity.ts`, after the `treasuryEffectiveAt` field at `:33-34`, add:

   ```ts
   @Column({ name: 'treasury_applied_effective_at', type: 'timestamptz', nullable: true })
   treasuryAppliedEffectiveAt!: Date | null;
   ```

3. In `unit-of-work.ts`, add `treasury_applied_effective_at: Date | null;` to `ProgramRow` (the
   interface at `:24-32`, after `treasury_effective_at`) and
   `program.treasuryAppliedEffectiveAt = row.treasury_applied_effective_at;` to `toProgramEntity`
   (after the `treasuryEffectiveAt` assignment at `:44`).

4. In `data-model.md`, add the column to the `program` table definition in the same row format the
   file already uses for `treasury_effective_at`, described as: the effective time of the newest
   treasury message applied to this program, from either topic; distinct from
   `treasury_effective_at`, which records the last applied snapshot only; null until a treasury
   message has been applied.

5. Add a case to `test/migration/migration.spec.ts`, in the style of the existing cases, named
   **"adds a nullable treasury_applied_effective_at that reverses cleanly"**: run migrations,
   assert the column exists and `is_nullable = 'YES'` via `information_schema.columns`, revert the
   last migration, assert the column is gone, re-run, assert it is back.

#### Constraints

- Do not backfill the column.
- Do not add it to the `Availability` schema or to any response body.
- Do not alter `treasury_effective_at` or `treasury_version` in this task.
- Do not change the existing migrations.

#### Edge Cases

- A program that has never received a treasury message keeps `NULL`.
- `down()` must drop only this column, leaving `treasury_effective_at` intact.

#### Verification

```bash
npm run typecheck
npm run lint
npx jest test/migration/migration.spec.ts
```

Expected:
- Typecheck and lint pass; the migration spec passes including the new case and the pre-existing
  reversibility and append-only cases.

#### Completion Criteria

- [ ] The migration adds and drops `treasury_applied_effective_at`, nullable, no default.
- [ ] Entity field and `ProgramRow`/`toProgramEntity` mapping exist.
- [ ] `data-model.md` documents the column and its distinction from `treasury_effective_at`.
- [ ] The new migration case passes.

### Task 2: Write the applied effective time from both apply paths

#### Objective

Every applied treasury message advances `treasury_applied_effective_at`, so the lag basis is
current whether the program is driven by events, snapshots or both.

#### Files

- `src/capacity/application/apply-treasury-event.service.ts` — new write.
- `src/capacity/application/apply-snapshot.service.ts` — extend the existing write.
- `test/integration/stale-reconciliation.spec.ts` or the event-path integration spec — assertions.

#### Implementation

1. **Event path.** `apply-treasury-event.service.ts` currently persists position through
   `programRepository.persistAdvance` and never writes program treasury columns. Inside the same
   `withProgramLock` transaction, after `persistAdvance` and using the same `manager`, add:

   ```sql
   UPDATE program
      SET treasury_applied_effective_at = $2
    WHERE id = $1
      AND (treasury_applied_effective_at IS NULL OR treasury_applied_effective_at < $2)
   ```

   with the event's `effectiveAt`. The guard makes the column monotonic: an out-of-order delivery
   that is still applied must not move the applied time backwards. Add a comment saying so.

   Place this write on the path that actually applies a delta. The echo-suppression branch
   (`:145-176`) returns before booking a ledger entry but **does** advance the stream position — it
   must also advance this column, because the message was applied in every sense that matters for
   lag. Add the same guarded `UPDATE` there.

   Do **not** write `treasury_version` or `treasury_effective_at` on this path.

2. **Snapshot path.** `apply-snapshot.service.ts:264-277` already runs an `UPDATE program` setting
   `treasury_version`, `treasury_effective_at`, `investigation_required` and `position_verified`.
   Add `treasury_applied_effective_at` to that same statement, set to the same value as
   `treasury_effective_at`, guarded the same way — either extend the `SET` list with a
   `GREATEST`-style guard expression
   (`treasury_applied_effective_at = GREATEST(COALESCE(treasury_applied_effective_at, $3), $3)`) or
   add a second guarded statement. Use the `GREATEST`/`COALESCE` form so the existing single
   statement is preserved.

3. Assertions. In the integration spec that covers the event apply path, add a case
   **"advances the applied effective time"**: apply an event with `effectiveAt` T and assert
   `program.treasury_applied_effective_at` equals T while `treasury_effective_at` stays null. Add
   **"does not move the applied effective time backwards"**: apply T, then apply a still-valid
   message with effective time T−60000, assert the column is still T. In
   `test/integration/snapshot-decomposition.spec.ts`, assert after an applied snapshot that
   `treasury_applied_effective_at` equals `treasury_effective_at`.

#### Constraints

- Do not write `treasury_version` or `treasury_effective_at` from the event path.
- Both writes stay inside the existing `withProgramLock` transaction and use its `manager`; do not
  open a second transaction or take a second lock.
- Do not change the ledger entries, the position arithmetic, or `persistAdvance` itself.
- Do not make the column non-null.

#### Edge Cases

- Quarantined message: nothing is applied, so nothing is written. The write must sit on the applied
  path only, never before a quarantine decision.
- `already_applied` (duplicate `message_id`): returns before applying, so no write.
- Echo-suppressed message: writes the column, per step 1.
- Out-of-order-but-valid delivery: the guard keeps the column monotonic.

#### Verification

```bash
npm run typecheck
npm run lint
npm test
```

Expected:
- Typecheck, lint and the whole default suite pass, including the new cases and every existing
  treasury integration spec.

#### Completion Criteria

- [ ] The event path writes the column on both the ordinary apply and the echo-suppression branch,
      with a monotonic guard, inside the existing transaction.
- [ ] The snapshot path writes it in its existing `UPDATE program`, guarded.
- [ ] Neither path writes `treasury_version` or `treasury_effective_at` where it did not before.
- [ ] The three named assertions pass; `npm test` is green.

### Task 3: Add a Redpanda testcontainer harness and a SASL switch

#### Objective

Specs can start a real broker with the topics the service expects.

#### Files

- `test/support/redpanda-container.ts` — created.
- `src/treasury/kafka.config.ts` — omit SASL when disabled.
- `src/config/env.schema.ts`, `.env.example` — `KAFKA_SASL_DISABLED`.
- `test/unit/kafka-config.spec.ts` — one added case.

#### Implementation

`@testcontainers/redpanda@12.1.0` is already a devDependency. Add no npm dependency.

1. Add to `src/config/env.schema.ts`, alongside the Kafka keys at `:9-23`:

   ```ts
   KAFKA_SASL_DISABLED: Joi.string().valid('true', 'false').default('false'),
   ```

   and `KAFKA_SASL_DISABLED=false` to `.env.example`.

2. In `src/treasury/kafka.config.ts`, make the `sasl` block at `:19-23` conditional:

   ```ts
   const saslDisabled = config.get<string>('KAFKA_SASL_DISABLED') === 'true';

   return {
     brokers,
     clientId: 'capacity-service',
     // Local compose brokers expose a PLAINTEXT+SASL listener; production requires SASL_SSL/mTLS per research R11.
     ssl: config.get<string>('NODE_ENV') === 'production',
     // The Redpanda testcontainer renders authentication_method: none and offers
     // no way to enable SASL, so tests set KAFKA_SASL_DISABLED=true. Never set in
     // compose or production, where the default 'false' keeps SCRAM mandatory.
     ...(saslDisabled
       ? {}
       : {
           sasl: {
             mechanism: 'scram-sha-512' as const,
             username: config.getOrThrow<string>('KAFKA_SASL_USERNAME'),
             password: config.getOrThrow<string>('KAFKA_SASL_PASSWORD'),
           },
         }),
     retry: { retries: 5 },
   };
   ```

   `KafkaConfig.sasl` is optional, so this typechecks. The `getOrThrow` calls sit inside the false
   branch and are not evaluated when SASL is disabled. Keep `brokers`, `clientId`, `ssl` and
   `retry` as they are.

3. Add one case to `test/unit/kafka-config.spec.ts` named
   **"omits the sasl block when KAFKA_SASL_DISABLED is true"**, asserting the returned config has no
   `sasl` property and that absent credentials do not throw. The file's `configFrom` helper
   (`:4-14`) throws on absent keys, which is what makes this a real assertion. Leave the existing
   cases at `:25`, `:41`, `:48` unchanged.

4. Create `test/support/redpanda-container.ts`, mirroring the lifecycle style of
   `test/support/postgres-container.ts` (which uses `.withStartupTimeout(120_000)` at `:22`).
   Export exactly:

   ```ts
   export interface RedpandaFixture {
     brokers: string[];
     eventsTopic: string;
     snapshotsTopic: string;
     dlqTopic: string;
     stop: () => Promise<void>;
   }

   export async function startRedpanda(): Promise<RedpandaFixture>;
   export function kafkaEnvFor(redpanda: RedpandaFixture): Record<string, string>;
   ```

   - `startRedpanda` constructs
     `new RedpandaContainer('docker.redpanda.com/redpandadata/redpanda:v24.2.18')` — the
     constructor requires an image string and has no default; this tag matches
     `docker-compose.yml:42` — with `.withStartupTimeout(120_000)`, starts it, and uses
     `getBootstrapServers()` as the single broker.
   - Topic names are the schema defaults: `treasury.capacity.events`,
     `treasury.capacity.snapshots`, `treasury.capacity.dlq`.
   - It creates all three topics with a `kafkajs` `Admin` client built against those brokers with
     **no** `sasl` and `ssl: false`, via
     `createTopics({ topics: [{ topic, numPartitions: 3, replicationFactor: 1 }, …], waitForLeaders: true })`,
     matching `docker-compose.yml:93-96`, then disconnects.
   - `stop()` stops the container.
   - `kafkaEnvFor` returns `KAFKA_BROKERS` (comma-joined), `KAFKA_CAPACITY_EVENTS_TOPIC`,
     `KAFKA_SNAPSHOTS_TOPIC`, `KAFKA_DLQ_TOPIC` and `KAFKA_SASL_DISABLED: 'true'`.

#### Constraints

- Do not add an npm dependency.
- Do not change `docker-compose.yml`.
- Do not set `KAFKA_SASL_DISABLED` outside test code.
- Do not change the existing assertions in `test/unit/kafka-config.spec.ts`.

#### Edge Cases

- `createTopics` returns `false` when a topic exists; that is not an error.
- Ports are mapped dynamically; never hardcode 9092 or 9093.
- Container startup is slow; specs must allow at least 120 s in `beforeAll`.

#### Verification

```bash
npm run typecheck
npm run lint
npx jest test/unit/kafka-config.spec.ts
ls node_modules/@testcontainers/redpanda/build
```

Then write a scratch spec `test/integration/redpanda-harness.smoke.spec.ts` calling
`startRedpanda()`, connecting a `kafkajs` admin client, calling `listTopics()`, asserting the three
topics are present, then `stop()`. Run it:

```bash
npx jest test/integration/redpanda-harness.smoke.spec.ts
```

Expected:
- Typecheck, lint and the kafka-config spec pass; the smoke spec passes and the container stops
  cleanly.

Delete `test/integration/redpanda-harness.smoke.spec.ts` before completing the task.

#### Completion Criteria

- [ ] `KAFKA_SASL_DISABLED` exists in `src/config/env.schema.ts` and `.env.example`.
- [ ] `buildKafkaConfig` omits `sasl` when it is `'true'` without evaluating the credential
      `getOrThrow`s.
- [ ] `test/support/redpanda-container.ts` exports the three symbols above, pins the image tag and
      creates three topics with 3 partitions.
- [ ] The new kafka-config case passes; existing ones unchanged.
- [ ] The smoke spec passed and was deleted.

### Task 4: Add the shared stream lag registry

#### Objective

A process-local, per-program record of the newest treasury effective time seen on the stream.

#### Files

- `src/shared/stream-lag/stream-lag.registry.ts`, `src/shared/stream-lag/index.ts` — created.
- `test/unit/stream-lag-registry.spec.ts` — created.

#### Implementation

The boundary policy forbids `application → treasury` and permits both `application → shared` and
`treasury → shared`, so the registry lives in `src/shared/`.

Create an `@Injectable()` class `StreamLagRegistry`:

```ts
observe(programId: string, effectiveAtMs: number): void
newestObservedFor(programId: string): number | null
```

- `observe` stores `effectiveAtMs` for `programId` only when greater than the stored value, so each
  program's value is monotonic. Ignore a non-finite or non-positive `effectiveAtMs`, and an empty
  `programId`, without throwing.
- `newestObservedFor` returns the stored value or `null`.
- State is a private `Map<string, number>`; do not expose it. No constructor dependencies.

Add `src/shared/stream-lag/index.ts` re-exporting `StreamLagRegistry`, matching the barrel
convention of `src/shared/correlation/index.ts`.

Unit cases, all named:
- **"returns null for a program with no observation"**.
- **"returns the observed effective time for a program"**.
- **"keeps the newest effective time when an older one is observed afterwards"** — 2000 then 1000,
  expect 2000.
- **"tracks programs independently"** — A at 1000, B at 3000; A still 1000.
- **"ignores a non-positive effective time"** — observe `-1`, expect `null`.

#### Constraints

- Do not put this class in `src/treasury/` or `src/observability/`; the boundary policy makes both
  unreadable from `capacity/application`.
- Do not persist anything.
- No dependency on `ConfigService`, TypeORM or kafkajs.

#### Edge Cases

- Same value twice: idempotent.
- Unknown program id: `null`, not 0.

#### Verification

```bash
npm run typecheck
npm run lint
npx jest test/unit/stream-lag-registry.spec.ts
```

Expected:
- Typecheck and lint pass — lint passing is what proves the boundary placement is legal.
- All five cases pass.

#### Completion Criteria

- [ ] `StreamLagRegistry` exists in `src/shared/stream-lag/` with exactly the two methods, keyed by
      program id.
- [ ] `index.ts` re-exports it.
- [ ] Five named cases pass; lint passes.

### Task 5: Add the lag probe consumer

#### Objective

A consumer tracking the head of the treasury stream per program, independent of the processing
consumer.

#### Files

- `src/treasury/consumer/stream-lag.probe.ts` — created.
- `src/capacity/capacity.module.ts` — provide and export the registry.
- `src/treasury/treasury.module.ts` — provide the probe.
- `src/config/env.schema.ts`, `.env.example` — `KAFKA_LAG_PROBE_ENABLED`.
- `test/integration/stream-lag.spec.ts` — created.
- The fifteen `AppModule`-booting specs listed in step 5 — one added `setEnv` line each.

#### Implementation

1. Add `KAFKA_LAG_PROBE_ENABLED: Joi.string().valid('true', 'false').default('true'),` to
   `src/config/env.schema.ts` and `KAFKA_LAG_PROBE_ENABLED=true` to `.env.example`.

2. Create `StreamLagProbe`, `@Injectable()`, implementing `OnModuleInit` and `OnModuleDestroy`,
   injecting `ConfigService` and `StreamLagRegistry`.

   - On init, return immediately when `KAFKA_LAG_PROBE_ENABLED` is `'false'`.
   - **Do not copy the `NODE_ENV === 'test'` early return from `treasury.consumer.ts:101-104`.**
     The probe must run under tests; that is how this task's and Task 7's specs exercise it.
     `KAFKA_LAG_PROBE_ENABLED=false` is the switch for specs that do not want it.
   - Build a `Kafka` client with `buildKafkaConfig(config)`.
   - Consumer group:
     `` `${config.getOrThrow<string>('KAFKA_CONSUMER_GROUP_ID')}-lag-probe` ``.
   - `subscribe` to `KAFKA_CAPACITY_EVENTS_TOPIC` and `KAFKA_SNAPSHOTS_TOPIC` with
     `fromBeginning: false`. Do **not** subscribe to the DLQ topic.
   - `run({ autoCommit: false, eachMessage: async ({ message }) => { … } })`. The body parses
     `message.value?.toString('utf8')` as JSON, reads top-level `programId` and `effectiveAt`,
     computes `Date.parse(effectiveAt)`, and calls `this.registry.observe(programId, parsed)` when
     `programId` is a non-empty string and the parse is not `NaN`. Nothing else: no database
     access, no handler call, no commit, no schema validation.
   - Wrap the body in try/catch; on failure log at `warn` and return. A throw would stall the
     probe's partition.
   - Connect in the background so a broker outage cannot stop the HTTP server booting, as
     `treasury.consumer.ts` does after its guard. Catch a connect failure, log at `error`, leave
     the registry empty.
   - On destroy, set a stopping flag and `disconnect()`.

3. In `src/capacity/capacity.module.ts`, add `StreamLagRegistry` to `providers` (`:27-46`) and to
   `exports` (`:47`, currently
   `[ApplyTreasuryEventService, ApplySnapshotService, ProgramStreamPositionRepository]`).

4. In `src/treasury/treasury.module.ts`, add **only** `StreamLagProbe` to `providers` (`:15-30`).
   `TreasuryModule` already has `imports: [CapacityModule]` at `:14`, so the probe receives the
   exact instance `CapacityModule` exports. Do **not** add `StreamLagRegistry` to
   `TreasuryModule.providers` — a second entry would create a second instance and availability
   reads would see an empty registry.

5. **Keep the probe off in every other spec that boots `AppModule`.** `TreasuryConsumer` is
   protected by its `NODE_ENV === 'test'` guard, but the probe deliberately has none and
   `KAFKA_LAG_PROBE_ENABLED` defaults to `'true'`, so without this step every such spec would dial
   the unreachable `localhost:9093`, spawn a kafkajs client that retries five times, and hold
   timers and sockets past `app.close()` — noisy at best, open-handle failures at worst. There is
   no `setupFiles` entry in `jest.config.ts` where a default could be injected, so each spec sets
   it itself. Add `setEnv('KAFKA_LAG_PROBE_ENABLED', 'false');` immediately after the existing
   `setEnv('KAFKA_BROKERS', …)` call in each of:

   - `test/contract/auth-enumeration.contract.spec.ts`
   - `test/contract/availability.contract.spec.ts`
   - `test/contract/releases.contract.spec.ts`
   - `test/contract/reservations.contract.spec.ts`
   - `test/integration/app-boot.spec.ts`
   - `test/integration/cancellation.spec.ts`
   - `test/integration/concurrency.spec.ts`
   - `test/integration/currency-mismatch.spec.ts`
   - `test/integration/ledger-audit.spec.ts`
   - `test/integration/read-your-writes.spec.ts`
   - `test/integration/recovery-detection.spec.ts`
   - `test/integration/release-nets-to-zero.spec.ts`
   - `test/integration/reserve-endpoint.spec.ts`
   - `test/performance/sc-003-availability-latency.spec.ts`
   - `test/performance/sc-003a-reservation-contention.spec.ts`

   Do **not** add it to `test/performance/sc-002a-treasury-visibility.spec.ts`, which needs the
   probe running (Task 7). `test/unit/no-auto-expiry.spec.ts` matches a search for `app.module` but
   only greps source text and boots nothing, so it needs no change. Each spec's existing `savedEnv`
   restore already undoes the variable.

Create `test/integration/stream-lag.spec.ts`, `jest.setTimeout(300_000)` at the top. Build the
module as:

```ts
Test.createTestingModule({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      load: [() => ({
        ...kafkaEnvFor(redpanda),
        KAFKA_CONSUMER_GROUP_ID: 'stream-lag-spec',
      })],
    }),
  ],
  providers: [StreamLagRegistry, StreamLagProbe],
}).compile()
```

then `await moduleRef.init()` so `onModuleInit` fires. Without `ConfigModule`, `StreamLagProbe`
cannot resolve `ConfigService` and instantiation fails.

Publish with a `kafkajs` producer against the container. `capacityEventMessage`
(`test/support/treasury.ts:68-91`) returns an `InboundMessage`, **not** a producer record, so send
`{ key: programId, value: capacityEventMessage({ … }).value }`. Its JSON carries `programId` and
`effectiveAt` at the top level (`:71-73`), which is what the probe parses; `snapshotMessage`
(`:117-120`) is the same shape.

Cases:
- **"records the effective time of a message published after the probe starts"** — produce one
  event for a known `programId` and `effectiveAt`, poll `registry.newestObservedFor(programId)`
  until non-null with a bounded wait, assert it equals `Date.parse(effectiveAt)`.
- **"reports null for a program with no message"** — assert `newestObservedFor(otherProgramId)` is
  null.
- **"keeps the newest effective time across the events and snapshots topics"** — event at T,
  snapshot at T+60000, same program; assert T+60000.
- **"does not commit offsets"** — call
  `admin.fetchOffsets({ groupId: 'stream-lag-spec-lag-probe', topics: [eventsTopic] })` and assert
  every partition's `offset` is `'-1'`; kafkajs 2.2.4 returns `-1` for an uncommitted partition
  rather than throwing or returning an empty list.

#### Constraints

- Never share `KAFKA_CONSUMER_GROUP_ID` with the processing consumer.
- Never commit an offset, write to the database, or invoke a handler.
- Do not change `treasury.consumer.ts`.
- Do not subscribe to the DLQ topic — republished quarantine records are not fresh treasury state
  and must not move the head.

#### Edge Cases

- `message.value` null, non-JSON, or missing either field: log at warn, skip, do not throw.
- `effectiveAt` unparseable: skip.
- Broker unreachable at startup: log at error, do not prevent boot. A null lag beats an API that
  will not start.
- Rebalance: the probe may briefly see no partitions; the registry keeps its last value, which is
  correct — a program's head does not move backwards.

#### Verification

```bash
npm run typecheck
npm run lint
npx jest test/integration/stream-lag.spec.ts
```

Expected:
- Typecheck and lint pass; all four cases pass.

#### Completion Criteria

- [ ] `StreamLagProbe` uses the `-lag-probe` group, subscribes to events and snapshots only,
      `autoCommit: false`, body calls only `registry.observe`.
- [ ] It carries no `NODE_ENV === 'test'` guard.
- [ ] `KAFKA_LAG_PROBE_ENABLED` is in `src/config/env.schema.ts` and `.env.example`.
- [ ] `StreamLagRegistry` is provided and exported by `CapacityModule` and provided by no other
      module.
- [ ] Every `AppModule`-booting spec except SC-002a sets `KAFKA_LAG_PROBE_ENABLED=false`.
- [ ] Four named cases pass.

### Task 6: Emit a real `lagSeconds` from the availability projection

#### Objective

Every response carrying an `Availability` body reports the measured lag instead of a hardcoded
null.

#### Files

- `src/capacity/application/availability.projection.ts`, `availability.service.ts`,
  `reserve.service.ts`, `release.service.ts`, `cancel.service.ts`.
- `specs/001-program-capacity-reservation/contracts/http-api.yaml`.
- `test/unit/availability-projection.spec.ts`, `test/contract/availability.contract.spec.ts`,
  `test/integration/reserve-service.spec.ts`, `test/integration/over-limit.spec.ts`,
  `test/integration/limit-reduction.spec.ts`.

#### Implementation

1. Change the signature at `availability.projection.ts:36` to
   `toAvailabilityBody(program, reconciliationPending: boolean, newestObservedEffectiveAtMs: number | null)`.
   The new parameter is appended last.

2. Delete the stale comment at `:70-72`, replace `lagSeconds: null` at `:73` with
   `lagSeconds: lagSecondsFor(program.treasuryAppliedEffectiveAt, newestObservedEffectiveAtMs)`,
   and add a module-level helper:

   ```ts
   // FR-007a: the distance between the newest treasury message applied to this
   // program and the newest one seen for it on the stream. Both operands are
   // business effective times from the message payload, so the difference is
   // meaningful and is zero for a caught-up program. Note this uses
   // treasuryAppliedEffectiveAt, which both apply paths advance — not
   // treasuryEffectiveAt, which only snapshots advance. Null means not knowable:
   // no treasury message has been applied, or this process has observed none for
   // the program. Null is never the same as zero.
   function lagSecondsFor(
     appliedEffectiveAt: Date | null,
     newestObservedEffectiveAtMs: number | null,
   ): number | null {
     if (appliedEffectiveAt === null || newestObservedEffectiveAtMs === null) {
       return null;
     }
     const deltaMs = newestObservedEffectiveAtMs - appliedEffectiveAt.getTime();
     return deltaMs <= 0 ? 0 : Math.floor(deltaMs / 1000);
   }
   ```

   Leave the `effectiveAt` response field at `:69` reading `program.treasuryEffectiveAt`.

3. Inject `StreamLagRegistry` (from `src/shared/stream-lag`) into all four callers and pass
   `this.streamLag.newestObservedFor(program.id)`: `availability.service.ts:31`,
   `reserve.service.ts:224`, `release.service.ts:222`, `cancel.service.ts:203` — using the program
   object already in scope (`programAfter` in the three write services). Add no lock, query or
   broker call; the registry read is a synchronous map lookup.

4. Update the **integration** specs that construct these services directly, appending a real
   `new StreamLagRegistry()` as the new last constructor argument:
   `test/integration/reserve-service.spec.ts:136` (Reserve),
   `test/integration/over-limit.spec.ts:81` (Reserve) and `:87` (Release),
   `test/integration/limit-reduction.spec.ts:81` (Release). There are **no unit specs** for these
   services, and `CancelService` is never constructed manually — it resolves through
   `CapacityModule`, so it needs no spec change. An empty registry returns `null`, preserving every
   current expectation about the embedded availability body.

5. In `contracts/http-api.yaml`, delete the comment at `:406-408` and give the `lagSeconds` node an
   inline `description`, keeping `type: [number, 'null']` and `minimum: 0` on that node and leaving
   `treasury.required` (`:401`) unchanged. The description states: the whole seconds between the
   newest treasury message applied to this program and the newest one available for it on the
   stream; null when no treasury message has been applied or the serving process has observed none
   for this program; null is never the same as zero.

6. Rewrite the two null assertions in `test/unit/availability-projection.spec.ts` at `:59` and
   `:66` as five cases:
   - **"reports null when the process has observed no message for the program"**.
   - **"reports null when no treasury message has been applied"** — applied time null, observation
     set.
   - **"reports the whole seconds between the applied effective time and the observed head"** —
     applied `T`, observed `T + 65_000`, expect `65`.
   - **"floors a partial second"** — observed `T + 1_900`, expect `1`.
   - **"reports zero when the applied effective time is at or ahead of the observed head"** —
     observed `T - 5_000`, expect `0`.

7. The third parameter is required, so update **every remaining** `toAvailabilityBody` call in
   `test/unit/availability-projection.spec.ts` — lines 26, 37, 54, 64, 72, 73 and 79 — to pass a
   third argument of `null`. Typecheck fails otherwise.

8. In `test/contract/availability.contract.spec.ts`, the case at `:191` asserts null for a program
   with no treasury state, which remains correct. Rename it to **"reports a null lag for a program
   with no applied treasury message"**; keep the assertion and the schema validation.

#### Constraints

- Do not add a lock, query or broker call to any read or write path.
- Do not change `type`, `minimum` or the required list for `lagSeconds`.
- Do not change `appliedVersion` or `effectiveAt`.
- Never emit a negative; the clamp is at zero.

#### Edge Cases

- Applied state exists but the process just restarted: observation null → `lagSeconds` null, not 0.
  A restarted process must not claim to be current.
- Observation older than the applied time: 0 by the clamp.
- Exactly equal: 0.

#### Verification

```bash
npm run typecheck
npm run lint
npx jest test/unit/availability-projection.spec.ts test/contract/availability.contract.spec.ts
npm test
grep -rn "lagSeconds: null" src/
grep -rn "toAvailabilityBody(" src/ test/
```

Expected:
- Typecheck is clean — no call site passes two arguments.
- Lint, the named specs and the whole default suite pass.
- The first `grep` returns nothing.
- The second shows every call passing three arguments.

#### Completion Criteria

- [ ] `toAvailabilityBody` derives the lag through `lagSecondsFor` from
      `treasuryAppliedEffectiveAt`.
- [ ] All four production call sites inject the registry and pass a per-program observation.
- [ ] The four integration construction sites pass a real `new StreamLagRegistry()`.
- [ ] Every call in `availability-projection.spec.ts` passes three arguments; five named cases pass.
- [ ] Contract comment deleted, `description` added, type/minimum/required unchanged.
- [ ] No `lagSeconds: null` literal in `src/`; `npm test` green.

### Task 7: Measure SC-002a through the broker

#### Objective

The SC-002a gate measures what SC-002a describes: a treasury-originated change reflected in an
availability read within 5 seconds, including broker and consumer time.

#### Files

- `test/performance/sc-002a-treasury-visibility.spec.ts` — rewritten.

#### Implementation

1. Keep `ITERATIONS = 25`, the `p99 <= 5_000` assertion and the existing percentile helper exactly.

2. **Set `NODE_ENV` to `'development'`** alongside the existing `setEnv` calls at `:107-113`,
   before `AppModule` is imported. Without this,
   `TreasuryConsumer.onModuleInit` returns early (`treasury.consumer.ts:101-104`), no message is
   ever applied, and every iteration times out. The `savedEnv` restore at `:170-176` already undoes
   it. Do not change the guard in `treasury.consumer.ts`.

3. Start the Task 3 Redpanda harness in `beforeAll` and apply `kafkaEnvFor(redpanda)` through the
   same `setEnv` mechanism, so the real `TreasuryConsumer` and `StreamLagProbe` connect to it. Keep
   the existing Postgres and Redis harness usage. Stop the container in `afterAll`. Put
   `jest.setTimeout(600_000)` at the top of the file.

4. Override `ThrottlerStorage` with the unlimited storage defined at
   `test/integration/read-your-writes.spec.ts:37-50` and applied at `:90-91`, so 25 iterations of
   polling are not rate limited. **That stub has no `redis` property, so also delete the
   `app.get(ThrottlerStorage)` cast and `storage.redis.disconnect()` at `:160-166`, keeping only
   `await app.close()`** — the Redis container is already stopped by `redis?.stop()` at `:183`.
   Deleting that teardown orphans one import: delete
   `import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';` at `:5`, and
   **keep** `import { ThrottlerStorage } from '@nestjs/throttler';` at `:4` — the `overrideProvider`
   token still needs it. Leaving the unused import fails `npm run lint`.

5. Publish with a `kafkajs` producer against the container:
   `await producer.send({ topic: eventsTopic, messages: [{ key: programId, value: capacityEventMessage({ … }).value }] })`.
   `capacityEventMessage` (`test/support/treasury.ts:68-91`) returns an `InboundMessage`, not a
   producer record — publish only its `.value` Buffer and supply the key separately.

6. Versions and the polled signal. The capacity-event path does **not** advance `treasury_version`
   (Task 2 deliberately leaves that alone), so `appliedVersion` stays 0 and must not be polled. Poll
   `reserved.treasury.amountMinor`, exactly as the current spec does at `:204-210`. The seeded
   program starts at `treasuryVersion: 0`. Publish one **warm-up** event at `version: 1` and wait
   for the treasury component to reach `EVENT_AMOUNT_MINOR` before timing anything; this absorbs
   consumer-group join. Then run the measured loop with `version: index + 2` for `index` in
   `0..24`, expecting `EVENT_AMOUNT_MINOR * BigInt(index + 2)` after each. Keep `effectiveAt`
   monotonic across all 26 messages:
   `new Date(Date.UTC(2026, 0, 1, 0, 0, versionNumber)).toISOString()`.

7. Per measured iteration: record `startedAt = Date.now()`, produce, then poll
   `GET /v1/programs/{programId}/availability` with the read scope every 50 ms until
   `BigInt(body.reserved.treasury.amountMinor) >= expected`, with a per-iteration timeout of 15 s.
   Record `Date.now() - startedAt`. On timeout, fail explicitly naming the expected and last
   observed treasury minor — a timeout must never become a slow sample.

8. Assert after the loop:
   - `p99 <= 5_000`;
   - the sample count is exactly `ITERATIONS` and every sample is a finite positive number;
   - on the final read, `body.treasury.lagSeconds === 0`. Step 7's poll loop discards each
     response, so declare a variable outside the loop, assign the last successful `read.body` to it
     on each iteration, and assert against that after the loop. This is now achievable and is the
     end-to-end proof: Task 2 makes the event path advance `treasury_applied_effective_at`, so a
     caught-up program's applied time equals the newest effective time the probe observed. A `null`
     here means the probe or the registry wiring is broken; a positive number means the consumer is
     behind.

#### Constraints

- Do not raise the 5-second budget or reduce the iteration count.
- Do not keep a direct `applyService.apply` fallback; the broker must be inside the window.
- Do not poll `appliedVersion`; it does not advance on the event path.
- Do not add this spec to the default jest project. `jest.config.ts:11-13` ignores
  `test/performance/`; `jest.perf.config.ts` runs it with `maxWorkers: 1`. Leave that unchanged.

#### Edge Cases

- The consumer may not have joined its group when the first message is published — that is what the
  warm-up event at version 1 is for, and it is outside the timing.
- A version not exceeding the applied one is ignored as stale, so versions must increase
  monotonically across the warm-up and the whole loop.
- If `lagSeconds` is null at the end, the probe observed nothing; the assertion catches it.

#### Verification

```bash
npm run typecheck
npm run test:perf
```

Expected:
- Typecheck passes.
- `test:perf` passes, including SC-003 and SC-003a, which this task does not touch.
- SC-002a reports 25 samples with a p99 at or under 5000 ms.

#### Completion Criteria

- [ ] The spec sets `NODE_ENV=development` before importing `AppModule`.
- [ ] It publishes to the real topic and polls `reserved.treasury.amountMinor` over HTTP.
- [ ] `ITERATIONS = 25` and `p99 <= 5_000` unchanged.
- [ ] The throttler teardown at `:159-166` is removed.
- [ ] A poll timeout fails with a diagnostic naming both values.
- [ ] The final read asserts `lagSeconds === 0`.
- [ ] No direct `applyService.apply` call remains.

### Task 8: Update the assumptions record and R11

#### Objective

The records describe the lag as it now works and the local listener as it really is.

#### Files

- `docs/ASSUMPTIONS.md` — replace the `lagSeconds` entries.
- `specs/001-program-capacity-reservation/research.md` — append to R11.

#### Implementation

1. `docs/ASSUMPTIONS.md` carries `lagSeconds` deferral entries at `:18` and `:59`. Replace all of
   them with one entry in the file's existing format (statement, what breaks if it is wrong, how it
   is detected):

   - **Statement**: `lagSeconds` is measured by a probe consumer in a dedicated consumer group that
     reads the head of both treasury topics and records, per program, the newest `effectiveAt` from
     the payload into a process-local registry. The reported value is the whole seconds between
     `program.treasury_applied_effective_at` — advanced by both the event and snapshot apply paths
     — and the newest effective time *this process* has observed for *that program*. Both operands
     are business effective times, not wall clocks. It is null when no treasury message has been
     applied to the program, or the process has observed none for it since starting: the probe
     subscribes from the latest offset and does not read history.
   - **What breaks if this is wrong**: a just-restarted process reports null rather than a figure
     until the next message for that program, so a client cannot distinguish "recently restarted"
     from "no treasury state". A stalled processing consumer is still detected, because the probe
     runs in its own group and keeps observing.
   - **How it is detected**: `test/integration/stream-lag.spec.ts` covers the registry and probe,
     and the SC-002a gate asserts `lagSeconds === 0` on a caught-up running application.

   Do not remove or reword entries unrelated to `lagSeconds`, including the four deviation entries
   added by the audit-remediation plan if that work has landed.

2. Append to R11 (`research.md:329`), after its "Alternatives considered" list, a subsection headed
   **"Deviation as implemented"** stating:
   - what ships locally (SCRAM-SHA-512 over a plaintext listener, `docker-compose.yml:57,60-63`)
     and in production (`ssl: true` plus SCRAM, `kafka.config.ts:18`);
   - that mTLS is not implemented, which R11 permits since it reads "`SASL_SSL` … **or** mTLS";
   - that the automated test broker goes further and disables SASL entirely via
     `KAFKA_SASL_DISABLED=true`, because `@testcontainers/redpanda` renders
     `authentication_method: none` and offers no way to enable it; the key defaults to `false` and
     is set only by test harness code;
   - why local TLS was not wired: self-signed certificates in compose are brittle and defend
     nothing on a loopback interface, while the risk R11 was written for — unauthenticated produce
     access letting an attacker inject a fabricated snapshot — is closed by SCRAM, which is
     exercised locally;
   - that this is already documented operationally in `docs/kafka-acls.md`.

#### Constraints

- Do not edit any source file in this task.
- Do not restate the `lagSeconds` deferral; it is over.
- Do not change the R11 **Decision** paragraph.

#### Edge Cases

- If either entry has already been reworded by other work, extend rather than duplicate.

#### Verification

```bash
grep -n "lagSeconds" docs/ASSUMPTIONS.md
grep -n "deferred" docs/ASSUMPTIONS.md
grep -n "Deviation as implemented" specs/001-program-capacity-reservation/research.md
```

Expected:
- Exactly one `lagSeconds` entry, describing the probe.
- The only surviving "deferred" hit is the unrelated ledger-partitioning line at `:100`
  ("dropped rather than deferred").
- The R11 subsection exists.

#### Completion Criteria

- [ ] One `lagSeconds` entry covering the probe, the new column and both null cases.
- [ ] No deferral language for `lagSeconds` remains.
- [ ] R11 carries "Deviation as implemented" with all five points; its Decision paragraph is
      unchanged.
- [ ] No source file changed.

## Final Verification

Commands:

```bash
npm run lint
npm run typecheck
npm test
npm run test:cov
npm run build
bash scripts/verify-uat.sh
npm run test:recovery
npm run test:perf
```

Expected:
- `lint`, `typecheck` and `build` succeed.
- `npm test` passes with zero skipped or todo tests.
- `test:cov` passes the 80/80/80/80 threshold, which must not have been lowered.
- `verify-uat.sh` exits 0.
- `test:recovery` passes; `test:perf` passes with SC-002a measuring through the broker.

Then confirm the requirement is met, not merely permitted:

```bash
grep -rn "lagSeconds: null" src/
grep -rn "lagSecondsFor" src/capacity/application/availability.projection.ts
grep -rn "StreamLagRegistry" src/capacity/capacity.module.ts src/treasury/treasury.module.ts
grep -rn "treasury_applied_effective_at" src/capacity/application/
```

Expected:
- The first returns nothing.
- The second shows the helper and its single call site.
- The third shows `StreamLagRegistry` in `capacity.module.ts` only.
- The fourth shows writes from both `apply-treasury-event.service.ts` and
  `apply-snapshot.service.ts`.

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

When stopping, the executor must report:

- the task number;
- the exact blocker;
- the evidence establishing the blocker;
- which plan assumption is invalid;
- the minimum planning decision required to continue.

The executor must **not** propose or implement an alternative unless explicitly asked to re-plan.
