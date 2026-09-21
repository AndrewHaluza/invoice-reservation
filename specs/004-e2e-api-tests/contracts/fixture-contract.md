# Contract: What a Scenario May Assume, and What It Must Establish

**Feature**: 004-e2e-api-tests | **Date**: 2026-09-21

FR-007 forbids one scenario depending on state another left behind. This states precisely
where the line falls, so that "independent" is checkable rather than a matter of taste.

---

## F-1 What a scenario MAY assume

Established once per file in `beforeAll`, by the shared bootstrap:

- **F-1.1** A migrated, empty schema on a running Postgres container.
- **F-1.2** A running Redis container backing the throttler.
- **F-1.3** The application assembled from the real `AppModule`, with the global validation
  pipe applied and an HTTP listener bound.
- **F-1.4** Seeded FX rates for the pairs the existing specs seed.
- **F-1.5** A rate-limit budget high enough that no scenario trips it incidentally. A
  scenario that *intends* to trip it would duplicate `reserve-endpoint.spec.ts` and is
  forbidden by FR-012.
- **F-1.6** A token-minting helper for a given organisation and scope.

## F-2 What a scenario MUST establish for itself

- **F-2.1** Its own organisation and its own program, with the credit limit, currency and
  position that scenario needs. **Two scenarios must not share a program row**, because a
  write in one changes `available` in the other.
- **F-2.2** Its own invoice identifiers, unique within its program.
- **F-2.3** Its own idempotency keys, unique within its organisation.
- **F-2.4** Any precondition beyond a fresh program — an existing reservation, an over-limit
  position, a pending idempotency record — created through the supported path, inside that
  scenario.

## F-3 What a scenario MUST NOT do

- **F-3.1** Read or assert a row another scenario created.
- **F-3.2** Depend on execution order, within its file or across files.
- **F-3.3** Set a program's position with `UPDATE`. Principle II forbids setting a position
  behind the ledger's back; the over-limit condition is reached through the snapshot path,
  which writes a compensating entry.
- **F-3.4** Write `over_limit_since` directly. The refusal does not read it (data-model.md),
  so such a scenario would assert a fixture and prove nothing.
- **F-3.5** Call a service, repository or policy directly. FR-001 requires every assertion
  to come from an HTTP response or from reading the resulting row.
- **F-3.6** Modify any existing file under `test/` other than the one line added to
  `jest.config.ts` (FR-009).

## F-4 The over-limit precondition, specifically

The only supported route, from R-001:

1. Insert a program with a known limit and a known local reservation.
2. Build the treasury harness over the owner `DataSource`.
3. Apply a reconciliation snapshot asserting a treasury figure such that
   `local + treasury > limit`.
4. Confirm the program row now satisfies `totalReserved > creditLimitMinor`.
5. **Then** issue the reservation over HTTP and assert the refusal.

Step 4 is not decoration. If the snapshot is rejected — by the delta guard, by a stale
version, or by a quarantine rule — the program is still within its limit and the reservation
succeeds. The scenario would then fail with a confusing `201`, and a reader would blame the
refusal logic rather than the fixture. Asserting the precondition makes the failure name
itself.

## F-5 Assertions every writing scenario owes

- **F-5.1** The HTTP status.
- **F-5.2** The response `code` where the response is a refusal.
- **F-5.3** The resulting `local_reserved_minor`, read back from the program row (FR-005).
- **F-5.4** For a refusal: that nothing was written — the position is byte-for-byte what it
  was before the request.
- **F-5.5** That the body carries no `stack`, `sql` or `query` key at any depth (FR-006).

## F-6 Teardown

- **F-6.1** Read `ThrottlerStorage`, `await app.close()`, then `storage.redis.disconnect()`.
  Closing the application alone leaves the Redis client open and Jest hangs.
- **F-6.2** Destroy the owner `DataSource`.
- **F-6.3** Restore every environment variable the file set.
- **F-6.4** Stop Redis, then Postgres.
- **F-6.5** Every step guarded, so a failure in `beforeAll` cannot cascade into a teardown
  crash that hides the original error.
