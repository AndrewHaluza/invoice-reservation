# Execution Plan: Phase 9 — Polish & cross-cutting concerns (T090–T102)

## Goal

Close the guarantees that span every story: continuous self-verification that flags and never
self-corrects, per-program recovery detection after a restore, proof that every route enforces
authentication and scope, the performance gates, and the assumptions record the constitution
requires.

## Preconditions

**Phases 3–8 are not merged as of this writing.** This plan is written against the state they leave
behind. Re-verify each fact below by reading the repository; if any is false, stop.

- Phases 3–8 have landed. Reserve, release, cancel, availability, audit reads, the treasury consumer
  and reconciliation snapshots all exist and are green.
- `program.investigation_required` and `position_verified` exist; phase 5 reports them, phase 8
  writes `investigation_required`. **Nothing writes `position_verified` yet** — T092 is its writer.
- `program_stream_position` is written inside the handling transaction (phase 7, T079).
- `scripts/audit-ledger.ts` and the `audit:ledger` npm script come from **phase 5 (T061)**, not from
  here. This plan's Final Verification calls `npm run audit:ledger`; if phase 5 did not wire it,
  that is a phase-5 gap to report, not something to re-implement here.
- `src/observability/metrics.ts` is **phase 2's**, and Task 2 depends on it existing. Confirm it
  before starting Task 2; creating it is out of scope here.
- `package.json` has **none** of `reconcile`, `test:recovery`, `test:perf` — Tasks 3, 5 and 7 add
  them.
- `jest.config.ts` has `roots: ['src', 'test']` and `testRegex: '.*\.spec\.ts$'`, so **any new
  spec under `test/` is picked up by plain `npm test` by default**. Tasks 5 and 7 must exclude
  themselves explicitly.
- `scripts/verify-uat.sh` encodes **phase 1** criteria only and never starts Docker. **Later phases
  need their own verifier — otherwise the gate keeps passing while measuring nothing.**
- `jest.config.ts` has a global 80% `coverageThreshold` and `roots: ['src', 'test']`.
- `.specify/memory/constitution.md` still carries a Sync Impact Report HTML comment.

## Target State

- A scheduled check compares active reservations against the `LOCAL` component, sets
  `investigation_required`, emits a metric, and **never self-corrects** (FR-019b, FR-019f, SC-004c).
- A program whose stream position is missing or behind its ledger starts `position_verified = FALSE`
  and refuses writes `POSITION_UNVERIFIED` at **503** — per `contracts/errors.md:27` and the
  `PositionUnverified` response in `http-api.yaml` — **per program, not service-wide** (FR-019e).
- Request-identifier retention is actually enforced: outcomes age out at 30 days while the
  identifiers survive indefinitely (FR-006b).
- Every route is proven to enforce authentication and scope, the two `security: []` health probes
  excepted, and error `details` never leaks `stack`, `sql` or `query` (SC-007, SC-007a).
- The performance harnesses exist as a release gate, not a per-commit cost.
- `docs/ASSUMPTIONS.md` exists and records the standing trade-offs.

## Scope

### In Scope

T090–T102: the reconciliation job and its manual script, recovery detection, the recovery test, the
auth-enumeration contract test, the performance harnesses, `docs/ASSUMPTIONS.md`, the Kafka topic
ACLs, the quickstart run, the coverage audit, and removing the constitution's scratch comment.

**T101 and T102 were added to tasks.md after the initial spec-kit generation** and are in scope
here:

- **T101 — the FR-006b retention sweep** (Task 13). The coverage sweep found it orphaned across all
  nine plans: phase 3 deferred it here, tasks.md never numbered it, and T042 already depends on its
  effect, so `IDEMPOTENCY_EXPIRED` was unreachable and `request_record` grew without bound.
- **T102 — extending `scripts/verify-uat.sh` to phases 3–8** (Task 9). The phase-1 verifier would
  otherwise keep passing over a system eight phases larger.

### Out of Scope

- Any new feature, endpoint or message type.
- Any change to the position arithmetic, the decomposition, or the release/snap rules.
- Lowering `coverageThreshold` for any reason.

## Key Decisions

1. **The verifier flags; it never self-corrects (SC-004c).** A job that silently rewrote the
   position would destroy the one property the ledger exists to provide — that every figure is
   explainable by entries.
2. **`POSITION_UNVERIFIED` is per program, and it is 503.** `contracts/errors.md:27` fixes the
   status and adds a subtlety worth encoding: **ownership resolution runs first**, so a program
   outside the caller's organisation answers **404**, never 503 — otherwise the refusal leaks that
   the program exists. A service-wide refusal would turn one program's recovery gap into a full
   outage; FR-019e scopes it deliberately.
3. **Recovery is detected at startup by comparing `program_stream_position` against the ledger**, not
   by trusting Kafka's committed offset — the offset lives outside the transaction and can be ahead.
4. **Performance specs are wired to `npm run test:perf`, not to `npm test`.** They are a release
   gate; running them per commit makes the suite unusable and tempts people to weaken them.
5. **The auth test enumerates routes from the router**, not from a hand-maintained list — a list
   goes stale the moment a route is added, which is precisely when the test matters.
   SC-007a is a **non-disclosure** property, not just a refusal count: a program belonging to
   another organisation and a program that does not exist must be **indistinguishable** in status
   and body. Asserting only "403 without scope" leaves the property untested, which is how it
   regresses.
6. **FR-006b is enforced here or nowhere.** Phase 3 deliberately deferred the retention sweep and
   made the `EXPIRED` state representable; T042 already *reads* the outcome-nulled case to answer
   `IDEMPOTENCY_EXPIRED`. T101 now schedules the ageing that produces it (Task 13). The sweep
   **nulls the outcome and keeps the row** — deleting it outright would make a reused identifier
   indistinguishable from a new one, which is the failure FR-006b names explicitly.
7. **`verify-uat.sh` is extended per phase or it measures nothing.** Add the phase 3–8 criteria as
   their own sections rather than leaving the phase 1 gate passing over a much larger system.

## Execution Order

### Task 1: `docs/ASSUMPTIONS.md` (T096)

FR-022 / Constitution VII. Record at minimum:

- reads go to the primary (FR-007b would break on a replica);
- the consumer shares a process with the HTTP server, so scaling triggers a rebalance that pauses
  ingestion — mitigated by cooperative-sticky assignment;
- the treasury producer's partitioning key is unratified: it affects throughput, not correctness;
- snapshots over-report between a release and the next snapshot (`reconciliationPending`);
- partitioning was **dropped, not deferred**.

Each entry states the assumption, what breaks if it is false, and how it would be detected.

### Task 2: The reconciliation verifier (T090)

`src/capacity/application/reconciliation-check.job.ts`: for each program, compare the sum of
`outstanding_reserved_minor` over active reservations against the `LOCAL` component; on a mismatch
set `investigation_required = TRUE`, emit the result as a metric through the existing
`src/observability/metrics.ts`, and **never write the position**. Schedule it on a configurable
interval (env var added to `env.schema.ts` **and** `.env.example` — they must match exactly).

Verification: a unit test proving the job writes no position column on a seeded mismatch.

### Task 3: `scripts/reconcile.ts` (T091)

A manual run of the same check, exit non-zero on any mismatch, printing program id, expected and
actual. Wire as an npm script. It calls the same service — no second implementation of the rule.

### Task 4: Recovery detection (T092)

At startup, for each program: if `program_stream_position` is missing or its offset is behind what
the ledger implies, set `position_verified = FALSE`. While false, **write** paths for that program
refuse `POSITION_UNVERIFIED` at **503** while reads continue and report the flag. The flag clears
only when a fresh snapshot re-establishes the position (phase 8's apply service).

Ordering matters: `ProgramScopeGuard` resolves ownership **before** the verification check, so a
program outside the caller's organisation answers 404 and never reveals its state
(`contracts/errors.md:27`).

Verification: integration test toggling the flag and asserting reserve/release/cancel all refuse
503 for that program while another program's writes succeed, plus one case proving a foreign
unverified program still answers 404.

### Task 5: `test/integration/ledger-recovery.spec.ts` (T093)

Restore from a ledger backup, resume the stream from the recorded per-program position, assert no
reservation is lost and no message is applied twice (SC-010). Wire as `npm run test:recovery`, and
exclude it from the default run the same way Task 7 excludes the performance specs — add its path to
`testPathIgnorePatterns` and re-include it in the `test:recovery` invocation. Confirm with
`npm test` that it does not run by default.

### Task 6: `test/contract/auth-enumeration.contract.spec.ts` (T094)

Enumerate every registered route from the Nest router and assert each one: 401 unauthenticated;
403 with a token lacking the route's scope; and that no error body's `details` contains a `stack`,
`sql` or `query` key — **at every status, 5xx included**, since a flattened 500 is exactly where
internals leak. The only auth exemptions are the two health probes declared `security: []`
(SC-007). A newly added route with no scope must fail this test.

**Boot the full `AppModule`.** A harness that assembles a subset of modules leaves out
`APP_FILTER` and asserts a pipeline that is not the one shipped — see the health-probe case below.

**Assert the health probes too, rather than only exempting them.** They are exempt from *auth*
(`security: []`), not from the contract: `/health/live` returns 200, and `/health/ready` returns
either 200 or **503** carrying the `Health` schema (`http-api.yaml:279-297`). `ready()` throws a
`ServiceUnavailableException` with an object body and no string `code`; a global filter that
flattens non-coded exceptions turns that into 500 `INTERNAL`, breaking the contract on the endpoint
orchestrators use to route traffic. `test/integration/health.spec.ts` cannot catch it — its
`buildApp` omits `CapacityModule`, so the filter is never in the pipeline it tests. Assert the 503
under the full module graph here.

**Plus the SC-007a non-disclosure assertion, which is the part most easily missed:** for each
program-scoped route, a request naming a program owned by **another organisation** and a request
naming a program id that **does not exist** must return the *same* status and the *same* body
shape — 404 both times. Assert equality of the two responses, not merely that each is a refusal.
A test that checks only "both are errors" passes while the endpoint leaks existence through a
403-vs-404 difference.

### Task 7: Performance harnesses (T095)

`test/performance/`, wired to `npm run test:perf`:

- SC-002a: a treasury change is visible in an availability read within 5s at p99;
- SC-003: availability read p95 < 1s at 200 concurrent clients;
- SC-003a: reservation p95 < 2s at 50 contending writers, **with no failure caused by contention
  alone** — deadlock-free ordering is what this asserts (multi-program locks go `ORDER BY id ASC`).

**Keep these out of the default run.** `jest.config.ts`'s `testRegex` would otherwise match
`test/performance/*.spec.ts` under plain `npm test` and `npm run test:cov`. Add
`test/performance/` to `testPathIgnorePatterns` in the default config and give `test:perf` its own
config (or `--testPathPattern test/performance`) that re-includes it. Verify by running `npm test`
and confirming no performance spec appears in the output.

### Task 8: Kafka topic ACLs (T097)

Configuration and documentation for both treasury topics and the DLQ: produce restricted to the
treasury identity; consume restricted to this service; DLQ read restricted to operations tooling;
replay routed through the ordinary validation path, never injected past it (FR-034, FR-036, R11).

### Task 9: Extend `scripts/verify-uat.sh` (T102)

Add the phase 3–8 acceptance criteria as their own sections, keeping the existing `.env.example` ↔
`env.schema.ts` equality assertion. The script still must not start Docker; it asserts what can be
asserted statically and names what it cannot.

### Task 13: The request-record retention sweep (T101)

Before T101 existed, the only mention of retention in tasks.md was T042, which **consumes** the
aged-out state (`outcome` nulled by retention → `IDEMPOTENCY_EXPIRED`) while nothing produced it.
Phase 3 deferred the sweep here explicitly. Without it `IDEMPOTENCY_EXPIRED` is dead code and
`request_record` grows without bound.

Implement a scheduled sweep in `src/capacity/application/request-retention.job.ts` that, for records older than the configured retention window
(default 30 days, an env var added to `env.schema.ts` **and** `.env.example`):

- nulls `outcome` and its content fingerprint payload, **keeping the row** — the PK
  `(organisation_id, request_id)`, the fingerprint hash and the owning organisation stay
  indefinitely, so a reused identifier is still recognised and answered `IDEMPOTENCY_EXPIRED`
  rather than mistaken for a new request (FR-006b's whole point: "Deleting the record outright
  would make the two indistinguishable");
- never deletes a `PENDING` row, whatever its age — an in-flight marker outliving its window is an
  incident to surface, not garbage to collect.

Write `test/integration/idempotency-retention.spec.ts`: a record past the window answers
`IDEMPOTENCY_EXPIRED` on reuse and is **not** treated as new; the row still exists; a `PENDING` row
is untouched.

### Task 10: The quickstart run (T098)

Run all ten `quickstart.md` scenarios against a fresh `docker compose up`, confirming a working
service inside 10 minutes from clone (SC-008). Fix the document where it has drifted; do not fix the
document by weakening a scenario.

### Task 11: Coverage and subsystem audit (T099)

`npm run test:cov` reports ≥ 80% and the threshold **fails the build** when it does not — verify by
temporarily breaking it, then restoring. Confirm every subsystem has a test home: `auth/`, `fx/`,
`treasury/dlq/`, `observability/`, `config/`, `migrations/`.

### Task 12: Remove the constitution scratch comment (T100)

Delete the Sync Impact Report HTML comment from `.specify/memory/constitution.md` — temporary review
scratch, not governance content.

## Final Verification

```bash
./scripts/dev-stack.sh env
docker compose down -v && docker compose up -d
npm run migration:run && npm run seed
npm run lint && npm run typecheck && npm test && npm run test:cov && npm run build
npm run audit:ledger && npm run reconcile
npm run test:recovery
npm run test:perf          # release gate
bash scripts/verify-uat.sh
```

Expected: every gate green; `verify-uat.sh` now measures phases 1–8 rather than phase 1 alone;
coverage at or above 80% **without** `coverageThreshold` having been touched.

## Executor Rules

1. Execute each task in a **separate sub-agent** with a fresh context.
2. Execute tasks strictly in numerical order.
3. Complete the current task and its verification before starting the next.
4. Implement the solution described in the plan exactly.
5. Do not redesign architecture or substitute a different approach.
6. Do not add features, cleanup, abstractions, or refactors the plan does not require.
7. Do not omit planned behavior because another implementation appears simpler.
8. Do not reinterpret product requirements.
9. Do not make optional improvements.
10. Follow existing project conventions where the plan explicitly relies on them.
11. Run the verification specified for every task.
12. Mark a task complete only when its completion criteria are satisfied.
13. If implementation reveals information that does not affect the prescribed solution, continue.
14. Stop rather than improvise when the plan cannot be executed as written.

Lowering `coverageThreshold`, weakening a performance target, or narrowing the auth enumeration is a
**stop-and-re-plan** condition. When stopping, report: the task number, the exact blocker, the
evidence, the invalid assumption, and the minimum planning decision required to continue.
