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
