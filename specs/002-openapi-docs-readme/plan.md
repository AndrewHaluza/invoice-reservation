# Implementation Plan: API Documentation & Project README

**Branch**: `002-openapi-docs-readme` | **Date**: 2026-09-21 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-openapi-docs-readme/spec.md`

## Summary

Serve the API's own description from the running service and give the repository a front
door.

The service gains a generated OpenAPI 3.1 document derived from its controllers and DTOs,
an interactive page rendered from it, and a README that takes a developer from clean clone
to a successful call. Nothing about the API's behaviour changes.

The design turns on one existing fact: `specs/001-program-capacity-reservation/contracts/http-api.yaml`
already describes this API by hand, and the contract suite already validates live responses
against its schemas. That file is not replaced and not duplicated. The generated document
becomes what the service *serves* — so it cannot drift from the code — and the hand-written
contract becomes the *oracle* that the generated document is tested against, on operations,
parameters, required scopes, and status codes. Drift in either direction fails the suite,
which is exactly what FR-031 asks for and what no amount of hand-editing can deliver.

The README is held true the same way: an automated check asserts that every command, path,
and configuration name it quotes exists in the repository.

## Technical Context

**Language/Version**: TypeScript 5.x (strict), Node.js 22.x (`>=22.0.0 <23`)

**Primary Dependencies**: NestJS 11, `@nestjs/swagger` ^11 (new), `class-validator` /
`class-transformer` (present), `js-yaml` + `ajv` / `ajv-formats` (present, dev — reused for
the conformance and validity checks)

**Storage**: PostgreSQL via TypeORM — untouched by this feature. No schema change, no
migration.

**Testing**: Jest. Unit specs in `test/unit/` (Docker-free), conformance and rendering specs
in `test/contract/`, one live-serving spec in `test/integration/` (testcontainers).

**Target Platform**: Linux/macOS server process; documentation page consumed in a browser,
description consumed by API clients and generators.

**Project Type**: Web service (single NestJS application, layered).

**Performance Goals**: The document is built once at bootstrap and cached; serving it must
not add measurable latency to any API request. Document generation must not extend startup
by more than ~250ms.

**Constraints**:
- The `api` boundary element may import only `application`, `domain`, and `shared`. It may
  not import `auth` or `config`. Swagger decorators come from `node_modules`, which is not a
  boundary element, so decorating controllers and DTOs is permitted; anything needing
  configuration lives in bootstrap, outside the matrix.
- Money is never a number. Every monetary field is documented as an integer string in minor
  units with an explicit currency.
- Adding an environment variable requires updating both `src/config/env.schema.ts` and
  `.env.example`, which `scripts/verify-uat.sh` asserts match exactly.
- Files 200–400 lines typical, 800 maximum; functions under 50 lines; no `any` without an
  inline justification.
- 80% global coverage threshold is enforced; new code must be covered.

**Scale/Scope**: 8 operations across 3 areas (capacity, audit, health). Roughly 12 request
and response DTO classes to decorate, one bootstrap module, two verification scripts, one
README. No new business logic.

## Constitution Check

*GATE: evaluated before Phase 0, re-evaluated after Phase 1.*

| Principle | Applies | Assessment |
|---|---|---|
| I — Money is never floating point | Yes | **PASS.** Every documented monetary field is `type: string, pattern: ^[0-9]+$` with a sibling ISO-4217 currency. A dedicated unit spec asserts that no schema in the generated document types a monetary field as `number` or `integer`. This is stricter than the prose requirement and makes the rule mechanically checkable. |
| II — Capacity is a ledger | No | Read-only feature. No ledger entry is written, read, or reinterpreted. |
| III — Concurrency safety | No | No code path touches a program row or a transaction. |
| IV — Idempotency and ordering | Documentation only | **PASS.** The feature documents the existing contract — required `Idempotency-Key`, matching replay returns the original outcome, differing replay is refused as `IDEMPOTENCY_CONFLICT`. It changes no behaviour. Documenting it accurately is a requirement (FR-017), and the conformance check ties the documented status codes to the ones the error filter actually maps. |
| V — Secure and authenticated by default | Yes — **requires explicit justification** | **PASS with justification.** The principle requires public access to be opt-in per route and explicitly justified. Two new routes are unauthenticated: the documentation page and the description endpoint. Justification: both serve the API's own *contract*, which is not tenant data and contains no organisation, program, invoice, or ledger content — only schemas, and examples drawn from the project's public seed identifiers. Controls: exposure is gated by a single configuration flag that defaults to enabled outside production and disabled in production; when disabled neither route is mounted at all, so a request is indistinguishable from any other unknown path. Crucially, the page is a client, not a bypass — requests it issues traverse the identical global guard chain (authentication, program scope, required scope), the identical validation pipe, and the identical per-organisation rate limiter. A test asserts that a call issued through the documented path without a credential is refused exactly as any other client's would be. Recorded in `docs/ASSUMPTIONS.md`. |
| VI — Test-first with failure coverage | Yes | **PASS.** Every item below is written test-first: the conformance spec fails before the document exists; the money-typing spec fails before the decorators land; the README spec fails before the README exists. Coverage stays at or above 80%. |
| VII — Runnable locally, observable | Yes | **PASS — this feature is largely the discharge of it.** The principle already demands a documented `.env.example` and a clean-clone bring-up; the README makes that claim checkable rather than assumed, and the check script enforces it. Structured logging, health endpoints, and metrics are untouched. New assumptions and the Principle V justification are recorded in `docs/ASSUMPTIONS.md`. |
| Tech constraints — boundaries | Yes | **PASS.** No new cross-layer import. Response DTO classes live in `api`, mirroring `application` body types through a compile-time assertion rather than a runtime dependency inversion. Bootstrap wiring lives outside the boundary matrix. |
| Tech constraints — migrations | N/A | No schema change. |
| Workflow — research before net-new | Yes | **PASS.** The generator, the validator, and the YAML loader are all existing or first-party packages. Nothing is hand-rolled: `ajv`, `ajv-formats`, and `js-yaml` are already dependencies used by `test/support/openapi.ts`, and this feature reuses that helper rather than writing a second one. |

**Gate result: PASS.** One item — the two unauthenticated routes under Principle V — requires
recorded justification rather than constituting a violation, and is discharged above and in
`docs/ASSUMPTIONS.md`. The Complexity Tracking table is therefore empty and omitted.

## Project Structure

### Documentation (this feature)

```text
specs/002-openapi-docs-readme/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── openapi-document.md      # What the served document must contain
│   └── docs-endpoints.md        # The two new routes and their exposure rules
├── checklists/
│   └── requirements.md  # Written by /speckit-specify
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
src/
├── main.ts                                  # MODIFIED: mount docs when enabled
├── config/
│   └── env.schema.ts                        # MODIFIED: API_DOCS_ENABLED
├── docs/                                    # NEW boundary element
│   ├── index.ts                             # public surface of the element
│   ├── openapi-document.factory.ts          # builds the document from the app
│   ├── openapi-metadata.ts                  # title, version, servers, tags, security
│   └── docs.bootstrap.ts                    # mounts page + description, gated by config
├── capacity/api/
│   ├── capacity.controller.ts               # MODIFIED: operation decorators
│   ├── audit.controller.ts                  # MODIFIED: operation decorators
│   ├── dto/                                 # MODIFIED: property decorators on requests
│   └── response/                            # NEW: documented response shapes
│       ├── availability.response.ts
│       ├── reservation.response.ts
│       ├── ledger-entry.response.ts
│       ├── page.response.ts
│       └── error.response.ts
└── observability/
    └── health.controller.ts                 # MODIFIED: marked as needing no credential

test/
├── unit/
│   ├── openapi-money-typing.spec.ts         # NEW: no monetary field is numeric
│   ├── openapi-metadata.spec.ts             # NEW: title/version/servers/security present
│   └── readme-references.spec.ts            # NEW: every quoted command/path/var exists
├── contract/
│   └── openapi-conformance.contract.spec.ts # NEW: generated document vs. 001 contract
└── integration/
    └── docs-endpoints.spec.ts               # NEW: served, gated, and grants no access

scripts/
└── verify-docs.sh                           # NEW: standalone documentation gate

.env.example                                 # MODIFIED: API_DOCS_ENABLED
README.md                                    # NEW
docs/ASSUMPTIONS.md                          # MODIFIED: Principle V justification + decisions
package.json                                 # MODIFIED: docs:verify, openapi:export scripts
eslint.config.mjs                            # MODIFIED: `docs` boundary element + policy
```

**Structure Decision**: The existing layered NestJS layout is kept exactly as it is. One new
boundary element, `src/docs/`, is introduced and declared in `eslint.config.mjs` with the
narrowest workable policy — it may reach `shared` and `config` only, never `domain`,
`application`, `infrastructure`, or `capacity/api`. It is a bootstrap concern that assembles
a document from an already-built application, so it needs no knowledge of any layer's
internals. Declaring it explicitly rather than leaving it unowned keeps the matrix total: an
unowned directory is a hole in the very rule the project treats as a design constraint rather
than a preference.

Response DTO classes are placed in `src/capacity/api/response/` rather than in `application`
because the `api` element may not be imported by `application`, and the documented HTTP shape
is an API concern. They are tied to the application body types by a compile-time assertion, so
a change to a body type that the response class does not mirror is a type error, not a silent
documentation lie.

## Phase 0 — Research

See [research.md](./research.md). Eight decisions were resolved; no `NEEDS CLARIFICATION`
remains. The consequential ones:

1. **`@nestjs/swagger` v11, OpenAPI 3.1.0** — matches the Nest 11 major and the version the
   existing hand-written contract already declares, so the two documents are directly
   comparable.
2. **Explicit decorators, no CLI plugin** — the plugin infers schemas at compile time via a
   TypeScript transformer, which does not run under `ts-node` (used by `scripts/seed.ts` and
   the other scripts) or under `ts-jest` without extra wiring, and would silently type money
   as `number` from its TypeScript type. Verbosity is accepted in exchange for the rule being
   visible at the field.
3. **The document is built from a real, initialised application** — under testcontainers in
   the conformance spec, reusing the existing Postgres and Redis fixtures. Mocking the
   container to avoid Docker was rejected: it would test a document built from a different
   object graph than the one the service serves, which is the one thing this feature must not
   do.
4. **The hand-written contract is the oracle, not the output** — the generated document is
   served; the 001 contract is what it is asserted against. Neither is deleted, and neither is
   hand-synchronised.

## Phase 1 — Design & Contracts

See [data-model.md](./data-model.md), [contracts/](./contracts/), and
[quickstart.md](./quickstart.md).

- **data-model.md** — the documented entities: the document itself, operations, the shared
  error shape, the money representation, pagination, and the tag groups. These are description
  structures, not persisted ones; the feature adds no table and no migration.
- **contracts/openapi-document.md** — what the served document must contain, operation by
  operation, including required scopes and the full status-code set per operation. This is the
  checklist the conformance spec encodes.
- **contracts/docs-endpoints.md** — the two new routes, their paths, their content types, and
  the exposure rules including the disabled behaviour.
- **quickstart.md** — the runnable validation path: bring the stack up, open the page, export
  the description, validate it, import it, and run the three verification commands.

### Constitution re-check after design

Re-evaluated against the design above: **PASS**, unchanged. The design adds no write path, no
schema change, and no cross-layer import; it introduces one new boundary element with a
strictly narrower policy than any existing element, and the two unauthenticated routes remain
justified and configuration-gated as recorded under Principle V. No new complexity requires
tracking.
