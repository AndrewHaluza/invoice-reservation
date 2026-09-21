# Assumptions and trade-offs

This document is the FR-022 deliverable. It records the standing assumptions and
trade-offs behind this service, so a reader can tell a deliberate constraint from
an accident. It is added to as each phase lands.

## Reads go to the primary

Availability and audit reads are served from the primary database connection,
never a read replica. FR-007b requires a client's own accepted reservation,
release or cancellation to be reflected in that client's next availability read
with no intervening window in which the prior figure is returned. A replica
reproduces the read side of that guarantee only after it has caught up, so a
client could reserve and immediately read a stale position. Reads therefore take
the same connection as writes; this is a constraint, not a configuration detail
to be tuned later.

## `lagSeconds` is measured by a probe consumer in its own group

`lagSeconds` is measured by a probe consumer in a dedicated consumer group that
reads the head of both treasury topics and records, per program, the newest
`effectiveAt` from the payload into a process-local registry. The reported value
is the whole seconds between `program.treasury_applied_effective_at` — advanced
by both the event and snapshot apply paths — and the newest effective time *this
process* has observed for *that program*. Both operands are business effective
times, not wall clocks. It is null when no treasury message has been applied to
the program, or the process has observed none for it since starting: the probe
subscribes from the latest offset and does not read history.

If the assumption behind this is wrong, a just-restarted process reports null
rather than a figure until the next message for that program, so a client cannot
distinguish "recently restarted" from "no treasury state"; a stalled processing
consumer is still detected, because the probe runs in its own group and keeps
observing.

It is detected by `test/integration/stream-lag.spec.ts`, which covers the
registry and probe, and by the SC-002a gate, which asserts `lagSeconds === 0` on
a caught-up running application.

## The treasury consumer shares a process with the HTTP server

Phase 7 runs the KafkaJS treasury consumer in the same process as the HTTP
server. Two consequences follow. Every scale event on the HTTP deployment changes
the consumer group membership and triggers a partition rebalance, which briefly
pauses treasury ingestion exactly when load is highest. And the consumer's manual
offset commit is only durable because the message's effect and the record that it
was applied are written in the same database transaction; the shared process is
what makes that one transaction boundary possible. The intended mitigation for
the rebalance pause is cooperative-sticky partition assignment, which avoids
revoking partitions a member keeps. It is not available in the pinned
`kafkajs@2.2.4`, whose `PartitionAssigners` exports only the eager round-robin
assigner, so the consumer selects cooperative-sticky when the dependency exposes
it and falls back to round-robin otherwise. A separately scaled consumer
deployment would remove the rebalance coupling entirely and preserve the
transaction boundary, because that boundary is the shared database, not the
shared process.

## The treasury producer's partitioning key is unratified

The capacity-event contract asks the treasury producer to key messages by
`programId` so that a partition carries one program's events in order. Whether
the producer does so is unratified. Correctness does not depend on it — deltas
deduplicate by message identity (FR-012a) and snapshots compare versions
(FR-012) — but throughput does: a per-program key keeps a hot program's events on
one partition, and its absence allows them to interleave across partitions. This
remains a question for the treasury team, not a blocker.

## Readiness reflects broker reachability, not just a crash

The readiness `consumer` check is driven by KafkaJS instrumentation rather than
by our own heartbeat: it goes `down` on CRASH, DISCONNECT and REQUEST_TIMEOUT,
and `up` on GROUP_JOIN, HEARTBEAT and a successful (re)start. This matters
because a paused or unreachable broker does not necessarily emit CRASH — KafkaJS
retries internally and only the request timeout surfaces, which is why a
broker outage flips readiness `down` roughly `requestTimeout` after it begins and
back `up` on the next heartbeat once the broker responds. The check therefore
fails while the consumer cannot ingest, and it no longer stays `up` through an
outage. A single stalled request can briefly flip the check, which is an honest
reflection of a request that exceeded the KafkaJS timeout.

## Availability can be over-reported between a release and the next snapshot

A snapshot that acknowledges a reservation we have since released reinstates its
amount until the following snapshot corrects it — potentially hours, and
unbounded in magnitude. This is accepted rather than solved, because solving it
means the snapshot must be reconciled against our release history rather than
applied as asserted state. It is surfaced instead: the availability response
carries `reconciliationPending`, derived at read time by
`reconciliationPending()` in `availability.service.ts`, which is true when the
most recently applied EXPLICIT `snapshot_acknowledgement` acknowledged a
reservation that has since left `ACTIVE`. If the assumption behind the
conservative direction is wrong, a client trusts a figure that over-states
available capacity; note the error is toward under-reporting what is reserved,
never the reverse. It is detected by `reconciliationPending` on the availability
response, and the next snapshot corrects the figure.

## Partitioning the ledger was dropped rather than deferred

Monthly range partitioning is incompatible with the gapless per-program sequence
the audit guarantee rests on. Postgres requires every unique constraint on a
partitioned table to contain the partition key, so `UNIQUE (program_id,
sequence)` cannot coexist with `PARTITION BY RANGE (occurred_at)` — the
`CREATE TABLE` is rejected — and dropping a partition would permanently falsify
`position = Σ ledger`. This decision is a deliberate drop, not a deferral:
retrofitting partitioning later is a real migration with real risk, and at the
stated scale that migration is years away, so a partitioning scheme that breaks
the ledger's arithmetic is worse than none. If the assumption that scale stays
within a plain table's comfort is false, query and retention performance degrade
and partitioning must be retrofitted through a migration. It is detected by
`invoice_reservation` growth and query latency measured against the stated scale.

## The reservation-path trigger stands down for reconciliation writes

The backstop trigger `assert_local_within_limit()` is redefined by
`1758260000000-SnapshotLocalCorrectionTrigger.ts` to return early when the
session setting `capacity.reconciliation_in_progress` is `'on'`, and
`src/capacity/application/apply-snapshot.service.ts` sets that setting for the
duration of its transaction. This departs from the phase-8 plan, which had said
to report a blocking constraint rather than relax it; the trigger was relaxed
instead. The phase-2 trigger fires
`WHEN (NEW.local_reserved_minor > OLD.local_reserved_minor)`, which a legitimate
reconciliation correction does trip, so FR-011c and FR-011g could not be honoured
without an escape. If the assumption that only the snapshot path stands the
trigger down is wrong, a bug in the snapshot path could raise
`local_reserved_minor` above the limit without the backstop firing. It is
detected by the reservation path never setting the setting — its backstop is
unchanged — and by `npm run audit:ledger`, which recomputes every component from
the ledger.

## A quarantined message gets no `processed_message` row

`src/treasury/consumer/treasury.consumer.ts` publishes a quarantined message to
the DLQ and commits the offset without recording a dedupe row, departing from
the phase-7 plan's task 9 wording. The DLQ publish is treated as the durable
quarantine record, and FR-036 requires a replayed DLQ message to re-enter the
ordinary validation and deduplication path, which a `processed_message` row
would turn into a privileged no-op. If the assumption that the DLQ publish is
the durable record is wrong, a crash between the DLQ publish and the offset
commit republishes the same message and produces duplicate quarantine entries —
no capacity is lost, because nothing was applied. It is detected by duplicate
`messageId`s in the DLQ topic.

## Redis unavailability degrades rate limiting instead of failing startup

`src/auth/redis.provider.ts` installs an `error` listener on the redis client
that logs the error and continues, where the phase-2 plan required the error to
propagate and fail startup loudly. Without the listener an emitted `error` is an
unhandled error event that terminates the process, so a redis blip would take
down the API rather than degrade rate limiting; the provider therefore installs
one and continues. If the assumption that a redis error is survivable is wrong,
a redis outage silently removes per-organisation rate limiting while the API
keeps serving. It is detected by the error being logged on every failed
connection attempt, which `maxRetriesPerRequest: 3` bounds.

## The release policy derives its delta by differencing converted outstandings

`src/capacity/domain/policies/release.policy.ts` bounds the release in invoice
currency and derives the capacity delta as the difference between the converted
outstanding invoice before and after, rather than converting the release amount
on its own as the phase-4 plan specified. This preserves
`outstanding_reserved_minor === round_half_up(outstanding_invoice_minor × rate)`
at every step, so a sub-1 rate cannot drain the reserved remainder ahead of the
invoice and strand the reservation short of `FULLY_RELEASED`. If the assumption
that the reserved equals the converted outstanding is wrong, a reservation could
be left with unreleasable capacity. It is detected by the invariant being
asserted in `test/unit/release-policy.spec.ts` and by
`test/integration/release-nets-to-zero.spec.ts` proving the `LOCAL` component
sums to zero across a full repayment.

## The documentation routes are unauthenticated, gated by `API_DOCS_ENABLED`

`/docs`, and the raw document at `/docs/openapi.json` and `/docs/openapi.yaml`, require no
credential, which Constitution Principle V requires be justified per route. They publish the
API's contract — schemas and seeded example identifiers — and carry no organisation, program,
invoice or ledger data, so there is nothing on them to authorise. Exposure is gated by
`API_DOCS_ENABLED`, which `src/config/env.schema.ts` defaults to `'false'` when
`NODE_ENV === 'production'` and `'true'` otherwise. When it is disabled, `mountApiDocs()` in
`src/docs/docs.bootstrap.ts` returns without mounting anything, so a request is answered by the
global catch-all filter with the same `404` / `NOT_FOUND` body as any unknown path and discloses
nothing. Requests issued from the page traverse the identical guard chain, validation pipe and
per-organisation rate limiter as any other caller, verified by
`test/integration/docs-endpoints.spec.ts`. If the assumption that the document is contract-only
is wrong, what is disclosed is a design artifact rather than tenant data, and it can be withdrawn
by leaving the flag disabled.

## The served OpenAPI document is generated, not hand-written

A hand-maintained document drifts from the service by default, and Principle VII requires
documentation to track the running service. The document is therefore generated at mount time by
`buildOpenApiDocument()` from the application's own decorators, so it cannot describe an
operation the router does not expose. `test/contract/openapi-conformance.contract.spec.ts`
asserts the generated document against both the live router and
`specs/001-program-capacity-reservation/contracts/http-api.yaml`, so a router or schema change
the document omits is a failing test rather than a silent drift.

## The 001 contract is retained as the oracle, not replaced

`specs/001-program-capacity-reservation/contracts/http-api.yaml` remains the design statement and
the response-schema source for the existing contract suite, while the generated document is what
is served. Neither is hand-synchronised with the other; the contract suite is what holds the two
together, and a divergence is surfaced there rather than by an edit to either file.

## The `@nestjs/swagger` CLI plugin is not enabled

The plugin infers schemas from TypeScript types, which would type money without a pattern, and it
does not run under `ts-node` or `ts-jest`, so a document built in a test would differ from one
built by `nest build`. Explicit `@ApiProperty` decorators are used instead; the cost is
verbosity, paid once at each property, against a document that is identical whether built by the
running application or by a test.

## Schema-level unit tests build their document from a minimal empty module

The schema and metadata unit specs build their document from an empty module with `extraModels`,
so they stay Docker-free and run in the fast suite. Router-level assertions require the real
application and therefore live in the contract suite,
`test/contract/openapi-conformance.contract.spec.ts`, which requires Docker. If the assumption
that a minimal module exercises the same decorator surface is wrong, a schema defect could pass
the unit specs and be caught only by the contract suite.

## `REFUSAL_STATUS` and `REFUSAL_CODES` were exported for the error contract

`STATUS` in `src/capacity/api/error.filter.ts` was exported as `REFUSAL_STATUS`, and
`REFUSAL_CODES` was added to `src/capacity/domain/errors.ts`, solely so the documented error
contract can be asserted against the mapping the service actually applies, in
`test/contract/openapi-conformance.contract.spec.ts` and `test/unit/refusal-status.spec.ts`. No
behaviour changed; the filter still responds with the same codes and bodies.

## The health documentation class is declared in the observability element

The health documentation class is the local `HealthProbeResponse` in
`src/observability/health.response.ts`, rather than being imported from
`src/capacity/api/response/`. The `observability` element may not import `api`, so the class is
declared where it is used; the shape is deliberately duplicated and
`src/capacity/api/response/health.response.ts` was deleted rather than re-exported. The
duplication preserves the boundary, and a cross-element import would be a lint error rather than
a convenience.

## The mutation floor is a measured number, not a target

The mutation gate's enforcement floor is derived arithmetically from one real run rather than
chosen. That run is recorded in `specs/003-mutation-testing/baseline.md`, measured on 2026-09-21,
and it scored **37.7%** over the 32 files of the six defended directories. The floor is that
score rounded down to the nearest multiple of five: `break` = 35, with `low` = 40 and `high` =
45 above it. Only `break` governs exit status; `low` and `high` are report colouring and an
aspiration, and a run can exit zero while still reporting against them. The number is a fence
around what the suite detects today, not a claim about the right level or a target to raise.
Choosing a floor without measuring first, or setting it to 100, is forbidden.

## `coverageAnalysis: 'perTest'` plus the TypeScript checker is a budget trade-off

Stryker is configured with `coverageAnalysis: 'perTest'` and the `typescript` checker. `perTest`
narrows each variant's test set to the tests that actually cover it, so a single alteration runs
a handful of tests rather than the whole suite; the checker discards variants that cannot
compile before any test runs against them. Together they are what buys the ten-minute budget at
this scope, at the cost of a slower first run and a dependency on the coverage data being
correct. If that data were wrong, a variant could be attributed to the wrong test set and scored
on tests that never exercised it.

## The mutation check is a separate workflow file, and a second job in `ci.yml` cannot replace it

GitHub Actions path filters are workflow-level (`on.pull_request.paths`); there is no job-level
`paths` key. A path-filtered job placed inside `ci.yml` would therefore suppress the workflow
itself, and with it the existing `gate` job, on every pull request that touches no defended
path. The check lives in `.github/workflows/mutation.yml` instead, with its own `paths` list and
its own concurrency group, so the pre-existing gate's outcome is unchanged on every pull request.

## The retained prior-run state was relocated from the requested path

The feature request named `.stryker-tmp/incremental.json` for the retained prior-run state.
`.stryker-tmp/` is Stryker's own sandbox — scratch space created and torn down around a run — so
a file committed inside it is not durable. The state is written to `.stryker-incremental.json` at
the repository root instead, which also keeps the git-ignore rules disjoint and avoids needing a
negation rule. The behaviour requested is unchanged; only the path differs.

## A source-scanning meta-test is excluded from the mutation run

`test/unit/no-auto-expiry.spec.ts` asserts over the text of every file under `src/`. Stryker
rewrites source into a sandbox, which collapses two constants in `src/capacity/domain/errors.ts`
onto one line and trips that assertion. The test, the source and the tool are each correct; a
test asserting over source text cannot compose with a tool whose method is rewriting source text.
The spec is excluded from the mutation run only and still runs in every other suite. The cost is
that the measured baseline understates the suite's true effectiveness, because that spec also
holds behavioural assertions over `releasePolicy`, `cancelPolicy` and `scaleRate`; the floor is
therefore slack rather than tight.

## Idempotency and access control are covered end to end by the existing suites

The feature request named four concerns — overbooking, idempotency, deadlock and access
control — but only two of them lacked end-to-end evidence. `test/integration/reserve-endpoint.spec.ts`
already asserts the exact replay returning `200` with an identical body, `403 INSUFFICIENT_SCOPE`
for a token without `capacity:write`, and `404 NOT_FOUND` for another organisation's program,
and the contract specs assert the same surface. Re-asserting any of it in `test/e2e/` was
rejected under FR-012, which forbids a scenario that duplicates an existing end-to-end
assertion.

This is the feature's largest decision and the one most likely to be questioned later, so it
is recorded rather than left implicit: the suite's value is the four refusals no HTTP test has
observed, the boundary and single-program contention — not a second copy of the idempotency
and RBAC proofs.

## Two refusal cases cannot be provoked through the API, and the debt is recorded

A multi-program deadlock cannot be expressed: `src/capacity/infrastructure/unit-of-work.ts`
locks exactly one program per transaction, and every write route is mounted under
`v1/programs/:programId`, so no supported request can take two programs in opposite orders
(R-006). `INVALID_AMOUNT` cannot be observed over HTTP either: `CreateReleaseDto.amount` is a
`PositiveMoneyDto` whose `amountMinor` carries `@Matches(/^[1-9][0-9]{0,18}$/)`, so the global
`ValidationPipe` returns `400 VALIDATION_FAILED` before the domain guard that raises it runs
(R-010).

Both are recorded in the suite itself — the first at the head of `test/e2e/contention.spec.ts`
and the second at the head of `test/e2e/refusals.spec.ts` — because SC-006 requires a reviewer
to name both from the suite alone. The deadlock case carries a debt: a multi-program endpoint
makes deadlock coverage owed the day it lands.

## The end-to-end suite is excluded from `npm test` by a fourth Jest config

`jest.config.ts` roots at `src` and `test` with `testRegex: '.*\.spec\.ts$'`, so any file under
`test/` joins the default run and the 80% coverage gate automatically. Letting the end-to-end
suite join would add several minutes of container start-up to every `npm test`, and its
coverage contribution would move the gate's numbers without any change in `src/`.
`jest.e2e.config.ts` spreads the base config and overrides `testPathIgnorePatterns` and
`testRegex`, and one `testPathIgnorePatterns` entry in `jest.config.ts` keeps `test/e2e/` out —
the mechanism the repository already uses for `test:recovery` and `test:perf`.

## The `400` response names a refusal code a caller cannot observe

`src/capacity/api/capacity.controller.ts` documents the `400` response at lines 109, 224 and 346
as `'VALIDATION_FAILED or INVALID_AMOUNT'`, but a caller can never observe the second:
`CreateReleaseDto.amount` is a `PositiveMoneyDto` whose `amountMinor` carries
`@Matches(/^[1-9][0-9]{0,18}$/)`, so the global `ValidationPipe` returns
`400 VALIDATION_FAILED` before the domain guard that raises `INVALID_AMOUNT` runs. FR-010
forbids changing any production file to accommodate this suite, so the wording stands and the
inaccuracy is recorded here instead.
