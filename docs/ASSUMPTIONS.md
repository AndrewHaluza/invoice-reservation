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

## `lagSeconds` is null until a stream reader exists

FR-007a defines the treasury lag against the newest message available on the
treasury stream. Phase 5 has no stream consumer and so cannot know the stream
head, which means it cannot compute that lag. The contract was amended so
`treasury.lagSeconds` is `type: [number, 'null']`: **null means the lag is not
knowable, and is never the same as zero.** Zero would assert that the position
is current; null asserts nothing. Phase 5 emits null unconditionally and phase 7
supplies the real figure once the consumer knows the stream head. No wall-clock
substitute is computed — reporting a fabricated zero for a program whose
treasury has never been reached is the one answer that would be actively
misleading.

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

## `lagSeconds` is still null

Phase 5 recorded that `treasury.lagSeconds` is null until a stream reader exists,
because the lag is defined against the newest message available on the stream
(FR-007a) and no component knew the stream head. Phase 7 adds the consumer but
still does not record the topic's high-water mark, so the stream head is still
not known and the figure remains null. Computing it properly — reading the
partition high-water marks and subtracting the program's recorded
`program_stream_position` offset — is deferred, and `null` continues to mean "not
knowable", never "current". Zero would assert the position is current; null
asserts nothing.

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
