# invoice-reservation

NestJS 11 + TypeORM + Postgres/Redis/Redpanda. Program capacity & invoice reservation ledger.
Node 22.x required.

## Commands

```bash
./scripts/dev-stack.sh        # stack + migrations + seed + API  ← use this, not `npm start`
./scripts/dev-stack.sh up     # infra only        down | reap | env
npm run typecheck && npm run lint
npm test                      # all (integration needs Docker)
npm run test:unit             # fast, no containers
npm run test:cov              # enforces 80% global threshold
npm run migration:generate -- src/migrations/<Name>
npm run migration:run | migration:revert
npm run seed
```

## Architecture

Today: `src/capacity/{domain,infrastructure}`, plus `shared`, `auth`, `config`, `observability`.
`application`, `api`, `fx`, `treasury` are declared boundary elements but not yet created —
they arrive with later phases (`docs/plans/`).

Layer deps are **enforced by eslint-plugin-boundaries** (`eslint.config.mjs`), default disallow:
- domain → domain, shared
- application → domain, infrastructure, shared, fx, config
- infrastructure → domain, shared, config
- api → application, domain, shared

A cross-layer import is a lint error, not a preference. Fix the design, not the config.

## Gotchas

- **Ports are per-worktree.** Karst allocates 4000–4100 and exports `PORT`/`PG_PORT`/
  `REDIS_PORT`/`KAFKA_PORT`/…; `scripts/dev-stack.sh env` prints the resolved set.
  Never hardcode 5432/6379/9092.
- **One compose stack per worktree**, namespaced by `COMPOSE_PROJECT_NAME` derived from the
  worktree path. `./scripts/dev-stack.sh reap` removes orphans of deleted worktrees.
- **Money is bigint minor units**, persisted through `bigint.transformer.ts`. Never float.
  Conversion + rounding live in `src/shared/money/`.
- Errors return `Result` (`src/shared/result/`) in domain/application; exceptions at the edge.
- Tests are `*.spec.ts`, all under `test/{unit,integration,migration}/`; integration uses `@testcontainers/*`
  (`test/support/`) and will fail without a Docker daemon.
- **Two DB roles, two URLs.** `DATABASE_URL` connects as `capacity_app` (member of `app_role`,
  NOT the table owner) so the ledger's `REVOKE UPDATE, DELETE` actually binds — the service
  cannot rewrite history. `MIGRATION_DATABASE_URL` connects as the owning `capacity` role and is
  used only by migrations. Roles are created in `docker/postgres-init.sql`. Never point the app
  at the owner URL to "fix" a permission error; the denial is the design.
- Env validated at boot by joi (`src/config/env.schema.ts`) — add new vars there or boot fails.
  `.env.example` holds the local values; `KAFKA_BROKERS` uses the SASL port (9093), not 9092.
- **Multi-program locks go `ORDER BY id ASC`.** `unit-of-work.ts` locks a single program today.
  Two transactions taking the same pair in opposite orders deadlock; Postgres aborts one, which
  surfaces as a failure caused by contention alone — SC-003a forbids that.
- **Route param must be named exactly `programId`.** `ProgramScopeGuard` resolves ownership only
  from that name and returns `true` (no check) for any other spelling. A renamed param silently
  disables the ownership check.
- **Idempotency is table-backed.** `request_record` (PK org+requestId, PENDING/COMPLETE +
  content fingerprint) for inbound API writes; `processed_message` for consumed Kafka messages.
  Reuse these, don't add a second scheme.
- **`.env.example` must declare exactly the vars `env.schema.ts` requires** — no more, no less.
  `scripts/verify-uat.sh` asserts the two match and fails UAT on drift.
- `scripts/verify-uat.sh` encodes **phase 1** criteria only and never starts Docker. Later phases
  need their own verifier — otherwise the gate keeps passing while measuring nothing.

## Workflow

Planning docs: `docs/plans/`, spec-kit artifacts: `specs/001-program-capacity-reservation/`.
Baseline branch: `develop`. Karst config: `.karst/karst.yml`.
