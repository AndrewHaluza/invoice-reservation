# Kafka topic ACLs for the treasury stream

Access control for the three treasury-stream topics. The policy is decided in
[`specs/001-program-capacity-reservation/research.md` R11](../specs/001-program-capacity-reservation/research.md)
and implements FR-034 (authentication) and FR-036 (DLQ access and replay). The
service side of the connection is configured in
[`src/treasury/kafka.config.ts`](../src/treasury/kafka.config.ts).

Transport is **always authenticated and encrypted**: production requires
`SASL_SSL` (SCRAM-SHA-512) or mTLS on every listener the service and the
treasury system use. Plaintext listeners are a local-development convenience
only.

## Principals

| Principal | Identity | Owner |
| --- | --- | --- |
| `User:treasury` | Treasury system producer identity | Treasury team |
| `User:capacity` | This service's consumer/producer identity (`capacity-service`) | This service |
| `User:ops` | Operations tooling identity (DLQ inspection and replay) | Operations |

## Policy

| Topic | Principal | Allowed operations | Purpose |
| --- | --- | --- | --- |
| `treasury.capacity.events` | `User:treasury` | `write` | Publish signed capacity deltas |
| `treasury.capacity.events` | `User:capacity` | `read`, `describe` | Consume deltas |
| `treasury.capacity.snapshots` | `User:treasury` | `write` | Publish periodic snapshots |
| `treasury.capacity.snapshots` | `User:capacity` | `read`, `describe` | Consume snapshots |
| `treasury.capacity.dlq` | `User:capacity` | `write` | Quarantine unapplicable messages |
| `treasury.capacity.dlq` | `User:ops` | `read`, `describe` | Inspect and replay quarantined messages |
| `capacity-treasury-consumer` (group) | `User:capacity` | `read`, `describe` | Commit consumer offsets |
| `ops-replay` (group) | `User:ops` | `read`, `describe` | Replay tooling consumer group |

Every other combination is denied by default: Redpanda denies any request that no
allow ACL matches. In particular there is no `write` grant for `User:capacity`
on either source topic, and no grant of any kind to `User:treasury` on the DLQ.

`write` is the Kafka operation that authorises a `Produce` request; `read` +
`describe` are what authorise `Fetch` (consume) and metadata lookups. Consuming
with a consumer group also needs `read`/`describe` on the group resource, which
is why those rows exist.

## Why the policy is shaped this way

### (a) Produce is treasury-only

The consumer validates message shape thoroughly — strict JSON schemas with
`additionalProperties: false`, echo detection and version comparison (see R4 /
FR-014). None of that answers **who** may produce. Every one of those checks
accepts a *well-formed* message from anyone.

If this service (or any other principal) could write to the source topics, an
attacker could inject a correctly-shaped snapshot with a fabricated
`reservedMinor` and a `WATERMARK` marker dated in the future. It would pass
schema validation, write off every live local reservation as
treasury-acknowledged, and free the capacity for fraudulent reservations — with
no HTTP credential involved and no guard in the path. That is the highest-value
surface in the system, so produce on both source topics is granted to the
treasury system's identity **alone**.

### (b) The service consumes but does not produce the source topics

`User:capacity` needs `read` on the two source topics to do its job, and nothing
more. Granting it `write` would make the service a second, uncontrolled producer
and collapse the "treasury is the sole source of truth" boundary that (a)
depends on. The only topic this service produces to is the DLQ.

### (c) The DLQ is read-restricted, and replay is a first-class path

Quarantined messages carry real program identifiers and real amounts, so reading
the DLQ is restricted to `User:ops` (operations tooling) — the same reasoning
that restricts the source topics in (a). Only this service produces to it.

**Replay rule.** A replay re-publishes the message to its **original source
topic**, so it re-enters the ORDINARY consumer path: schema validation, identity
dedupe and version checks all run exactly as they do for a fresh message. A
replay is never injected past the consumer and never written directly to the
database; doing either would bypass the very checks that make ingestion safe and
would let a bad quarantine message corrupt the ledger. Each replay is logged with
the operator identity and the original message's coordinates (topic, partition,
offset), so the DLQ is never a silent side channel.

`dlq_depth` is monitored and alerts on growth; a DLQ that fills silently is the
same failure as losing the messages.

### (d) Transport security is mandatory in production

Both treasury topics and the DLQ require `SASL_SSL` (SCRAM-SHA-512) or mTLS in
production. Authentication establishes the principal that the ACLs above are
keyed on; encryption keeps credentials and payloads off the wire. The local
compose stack runs the same SASL/SCRAM authentication with development
credentials (`SCRAM-SHA-512` over the SASL listener) so the production code path
is the one that gets exercised. `src/treasury/kafka.config.ts` sets `ssl: true`
when `NODE_ENV=production` and always negotiates SCRAM-SHA-512.

> **Local enforcement is nominal.** The local `redpanda` service keeps
> `capacity` in `redpanda.superusers`, and a superuser bypasses ACL checks. The
> local ACLs exist so the same commands and identities are exercised, not to
> enforce the boundary on a laptop. Production grants the service a
> **non-superuser** identity so the ACLs actually bind.

## rpk commands

Run against the broker with an identity that may create ACLs. The exact commands
are what `redpanda-init` runs locally (see `docker-compose.yml`).

```bash
# Identities
rpk security user create treasury --password <treasury-secret> --mechanism SCRAM-SHA-512
rpk security user create ops     --password <ops-secret>      --mechanism SCRAM-SHA-512
rpk security user create capacity --password <capacity-secret> --mechanism SCRAM-SHA-512

# Treasury system: sole producer of the two source topics
rpk acl create --allow-principal User:treasury --operation write --topic treasury.capacity.events
rpk acl create --allow-principal User:treasury --operation write --topic treasury.capacity.snapshots

# This service: consume the source topics (topic + group), produce the DLQ
rpk acl create --allow-principal User:capacity --operation read,describe --topic treasury.capacity.events
rpk acl create --allow-principal User:capacity --operation read,describe --topic treasury.capacity.snapshots
rpk acl create --allow-principal User:capacity --operation read,describe --group capacity-treasury-consumer
rpk acl create --allow-principal User:capacity --operation write --topic treasury.capacity.dlq

# Operations tooling: read/consume the DLQ only
rpk acl create --allow-principal User:ops --operation read,describe --topic treasury.capacity.dlq
rpk acl create --allow-principal User:ops --operation read,describe --group ops-replay
```

Verify with:

```bash
rpk acl list --allow-principal User:treasury
rpk acl list --allow-principal User:capacity
rpk acl list --allow-principal User:ops
```
