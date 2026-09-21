# Program Capacity & Invoice Reservation

This service is the capacity and invoice reservation ledger for financing programs. Each program
has a credit limit, and every change to its position — a limit change, a reservation, a release, a
cancellation, or a treasury snapshot — is appended to a ledger, from which the current position is
derived. History is never rewritten; the service appends and re-derives.

Positions are reconciled against an external treasury system over a message stream. Treasury
snapshots arrive as events, are validated against the locally derived position, and are applied or
held for investigation; when the two disagree, reads that depend on the position fail rather than
report a figure the ledger cannot vouch for.

## Prerequisites

- Node.js `>=22.0.0 <23`.
- A running Docker daemon.

## Running it

`./scripts/dev-stack.sh` brings up Postgres, Redis, and Redpanda, runs migrations, seeds, and
starts the API.

Ports are allocated per worktree; 5432, 6379, and 9092 must never be assumed. `./scripts/dev-stack.sh env`
prints the resolved set.

Subcommands:

- `./scripts/dev-stack.sh up` — infrastructure only.
- `./scripts/dev-stack.sh down` — tear down this worktree's stack, volumes included.
- `./scripts/dev-stack.sh reap` — remove stacks whose worktree no longer exists.
- `./scripts/dev-stack.sh env` — print the resolved environment for this worktree.

## First call

Capture the resolved environment, then seed:

```bash
eval "$(./scripts/dev-stack.sh env | sed 's/^/export /')"
npm run seed
```

`npm run seed` prints one credential per organisation to stdout. Export the token for one of them
as `TOKEN`:

```bash
export TOKEN=<token printed by the seed>
```

The Northwind program is the seeded constant `NORTHWIND_USD_PROGRAM_ID`, with the value
`b1b2c3d4-0001-4000-8000-000000000011`. A complete `GET` against
`/v1/programs/{programId}/availability`:

```bash
curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  "http://localhost:$PORT/v1/programs/b1b2c3d4-0001-4000-8000-000000000011/availability"
```

## API documentation

`API_DOCS_ENABLED` controls exposure. It defaults to enabled outside production and disabled in
production. When it is disabled the paths are not registered at all.

When enabled, the running service serves the Swagger UI at /docs, the OpenAPI 3.1 JSON document
at /docs/openapi.json, and the YAML document at /docs/openapi.yaml
([open the UI](http://localhost:3000/docs)).

## Testing

- `npm run test:unit` — unit suite, no Docker.
- `npm test` — full suite including integration, needs a Docker daemon.
- `npm run test:cov` — coverage, enforces the 80% global threshold.
- `npm run test:recovery` — ledger recovery suite.
- `npm run test:perf` — performance suite.
- `npm run docs:verify` — the documentation gate.
- `npm run test:mutation` — mutation suite, no Docker.

## Architecture

The elements under `src/` are `capacity/domain`, `capacity/application`,
`capacity/infrastructure`, `capacity/api`, plus `shared`, `auth`, `config`, `observability`,
`treasury`, `fx`, and `docs`.

Cross-element dependencies are enforced by `eslint-plugin-boundaries` in `eslint.config.mjs`; a
violation is a lint error, not a preference.

## Configuration

All configuration is environment-supplied and validated at boot by Joi in
`src/config/env.schema.ts`; boot fails naming any missing variable. `.env.example` holds the local
values, and its values are local development only.

## Further reading

- [Constitution](.specify/memory/constitution.md)
- [Assumptions](docs/ASSUMPTIONS.md)
- [Kafka ACLs](docs/kafka-acls.md)
- [Plans](docs/plans/)
- [Specifications](specs/)
- [Mutation testing](docs/testing-mutation.md)
