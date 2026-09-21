# Phase 0 Research: API Documentation & Project README

**Feature**: `002-openapi-docs-readme` | **Date**: 2026-09-21

All unknowns from the plan's Technical Context are resolved below. No
`NEEDS CLARIFICATION` remains.

---

## R-001 — Document generator

**Decision**: `@nestjs/swagger` at the v11 major line, emitting **OpenAPI 3.1.0** via
`DocumentBuilder().setOpenAPIVersion('3.1.0')`.

**Rationale**: It is the first-party Nest package, its major line tracks the framework's
(the project is on Nest 11), and it derives the document from the same metadata the router
already holds — which is precisely what FR-002 requires. 3.1.0 is chosen over the package
default of 3.0.x for two concrete reasons: the existing hand-written contract at
`specs/001-program-capacity-reservation/contracts/http-api.yaml` declares `openapi: 3.1.0`,
so comparing the two needs no version translation; and 3.1 schemas *are* JSON Schema
2020-12, which the repository's existing `test/support/openapi.ts` helper already compiles
with `Ajv2020`. Choosing 3.0 would mean two dialects in one repository and a second
validator.

**Alternatives considered**:
- *Hand-maintaining a YAML file and serving it statically.* Rejected. It is what the
  repository already has, and it is the exact failure mode FR-002 and FR-031 exist to
  prevent — a file that is correct on the day it is written and silently wrong thereafter.
- *`tsoa` / `swagger-jsdoc` / other third-party generators.* Rejected. Both would require
  either a second source of truth (JSDoc comments) or a different routing model than the one
  the service uses. Neither justifies displacing the first-party package.
- *Emitting 3.0.x.* Rejected as above.

---

## R-002 — Schema derivation: explicit decorators, not the CLI plugin

**Decision**: Decorate DTO fields explicitly with `@ApiProperty` / `@ApiPropertyOptional`.
Do **not** enable the `@nestjs/swagger` CLI plugin in `nest-cli.json`.

**Rationale**: The plugin is a TypeScript transformer that infers schemas from declared
types at compile time. Three problems, in descending order of seriousness:

1. **It would type money wrongly and invisibly.** The plugin infers from the TypeScript
   type. Where a field is a `string` carrying an integer in minor units, the plugin produces
   a bare `type: string` with no pattern and no explanation, and where any numeric field
   exists it produces `type: number`. Principle I is non-negotiable and the project's whole
   posture is that money's representation must be *stated*, not inferred. An explicit
   `@ApiProperty({ type: String, pattern: '^[0-9]+$', example: '150000' })` puts the rule at
   the field where a reader and a reviewer both see it.
2. **It does not run outside `nest build`.** `scripts/seed.ts`, `scripts/audit-ledger.ts`,
   and `scripts/reconcile.ts` run under `ts-node`, and the suite runs under `ts-jest`.
   Neither applies the plugin's transformer without additional configuration, so a document
   generated in a test would differ from one generated from a build — the two artefacts this
   feature must keep identical.
3. **It hides the contract from review.** A reviewer reading a decorated DTO sees the
   documented shape. A reviewer reading an undecorated one sees nothing and must run the
   generator to know what was published.

**Cost accepted**: verbosity. Roughly 12 DTO classes gain decorators. This is a one-time
cost on a surface that changes rarely.

**Alternatives considered**:
- *Enable the plugin and override money fields by hand.* Rejected: it yields the verbosity
  anyway for exactly the fields that matter, while leaving every other field's contract
  invisible and dependent on transformer configuration.

---

## R-003 — Building the document from a real application

**Decision**: Generate the document from a fully initialised Nest application. In the
conformance and integration specs this means booting the app against the existing
testcontainers fixtures (`test/support/postgres-container.ts`,
`test/support/redis-container.ts`), the same way `test/contract/*.contract.spec.ts` already
does.

**Rationale**: `SwaggerModule.createDocument` scans the router of a *built* application, so
the document is a function of the real object graph. Building it from a stubbed or mocked
graph would produce a document describing an application that is not the one shipped —
defeating the single property (FR-002, FR-031) that motivates generating it at all. The
repository already has a working, reused pattern for booting the real app under containers;
this feature reuses it rather than inventing a Docker-free path.

**Consequence, stated plainly**: the conformance spec requires Docker and therefore runs
under `npm test`, not `npm run test:unit`. Three cheaper checks — money typing, document
metadata, and README references — are structured to run without Docker so that the fast
suite still catches the most common regressions.

**Alternatives considered**:
- *`NestFactory.create(AppModule, { preview: true })`.* Rejected: preview mode does not
  instantiate controllers, so there is no router to scan.
- *A `Test.createTestingModule` graph with `DataSource`, the Redis client, and the treasury
  consumer overridden.* Rejected: it avoids Docker but requires maintaining a parallel list
  of every provider that touches I/O at init. That list would rot, and the failure mode when
  it does is a document generated from a subtly different graph — silent, and in the one
  place silence is unacceptable.

---

## R-004 — The hand-written contract becomes the oracle

**Decision**: Keep `specs/001-program-capacity-reservation/contracts/http-api.yaml` exactly
where it is. Serve the **generated** document. Add a conformance spec asserting that the
generated document and the hand-written contract agree on: the set of path-and-method pairs,
`operationId`s, path and query parameters, required headers, the `x-required-scope` extension
per operation, and the set of response status codes per operation.

**Rationale**: This is the highest-leverage decision in the feature, and it falls out of a
fact already true in the repository: the 001 contract is not documentation-in-a-drawer. The
contract suite compiles its schemas with Ajv and validates live HTTP responses against them,
and `scripts/verify-uat.sh` asserts that it declares each `x-required-scope`. It is a tested,
reviewed statement of intended design.

What it cannot do is notice an operation that exists in code and not in the contract, or
vice versa. What the generated document cannot do is notice that the code drifted from what
was *designed*. Running both and asserting they agree closes both directions with no
hand-synchronisation: a new endpoint fails the suite until the contract is updated, and a
contract entry with no implementation fails it too.

**Alternatives considered**:
- *Delete the hand-written contract once generation works.* Rejected: it would discard the
  design intent and the response-schema oracle the contract suite depends on, converting four
  existing specs into no-ops.
- *Serve the hand-written contract and drop generation.* Rejected: violates FR-002 and
  reinstates the drift the feature exists to eliminate.
- *Generate the file into the repository on a pre-commit hook and diff it.* Rejected: a
  generated artefact committed to version control invites hand-editing and produces review
  noise on every unrelated change. An assertion is cheaper than an artefact.

---

## R-005 — Exposure, path, and configuration

**Decision**: A single boolean environment variable `API_DOCS_ENABLED`, validated by Joi with
a default that is `true` when `NODE_ENV` is not `production` and `false` when it is. Routes:

| Path | Serves |
|---|---|
| `/docs` | the interactive page |
| `/docs/openapi.json` | the description, JSON |
| `/docs/openapi.yaml` | the description, YAML |

When the flag is false, nothing is mounted — the paths are not registered at all.

**Rationale**: Principle V requires public access to be opt-in per route and justified; a
flag with a production-safe default is the narrowest mechanism that satisfies both FR-015
(configurable, disableable without a code change) and the constitution. Not mounting — rather
than mounting and refusing — is what makes FR-020 and SC-009 hold: an unmounted path produces
the same `NOT_FOUND` body from the existing error filter as any other unknown path, so a
prober learns nothing about whether the feature exists, let alone whether it is switched off.

Serving both JSON and YAML costs one serialisation call and removes a conversion step for
readers; API clients overwhelmingly prefer JSON, humans and diff tools prefer YAML.

**Alternatives considered**:
- *Mount always, guard with `@Public()` and a runtime check.* Rejected: a guarded route that
  returns 403 when disabled advertises its own existence.
- *Derive exposure from `NODE_ENV` alone with no flag.* Rejected: FR-015 requires an explicit
  off switch, and a team that wants the contract available in a staging or production
  environment behind a network boundary must not have to change code to get it.

---

## R-006 — Boundary placement

**Decision**: A new `src/docs/` boundary element, declared in `eslint.config.mjs`, permitted
to import `shared` and `config` only. Controllers and DTOs in `src/capacity/api/` gain
decorators from `@nestjs/swagger`. Response DTO classes are added under
`src/capacity/api/response/`.

**Rationale**: `eslint-plugin-boundaries` defaults to disallow, and an element's policy is the
project's design statement about what it may know. The document factory assembles a
description from an already-built `INestApplication`; it needs the metadata object and the
configuration flag, and nothing else. Giving it `shared` and `config` — the narrowest policy
any element in the matrix has — states that.

Decorating `api` files raises no boundary question: `@nestjs/swagger` is a `node_modules`
package, and `boundaries/include` is scoped to `src/**/*.ts`, so external packages are outside
the matrix entirely.

Response DTOs must live in `api`, not `application`, for a structural reason: `application`
may not import `api`, and the documented HTTP shape is an API concern. The tie to the
application body types is made at compile time — each response class carries an assertion that
it is assignable to the corresponding body type — so a change to a body type that the response
class does not mirror is a build failure rather than a documentation lie.

**Alternatives considered**:
- *Put the factory in `src/observability/`.* Rejected: observability's policy already permits
  `shared` and `config`, so it would fit mechanically, but the element means something — health,
  metrics, logging — and an API description is not telemetry. Overloading it would make the
  matrix a filing system rather than a design.
- *Leave `src/docs/` unowned (the matrix has `no-unknown-files: off`).* Rejected: an unowned
  directory can import anything, which is a hole in the rule the project treats as binding.

---

## R-007 — Keeping the README true

**Decision**: A Docker-free Jest spec, `test/unit/readme-references.spec.ts`, parses
`README.md` and asserts that every fenced command, every repository path, and every
`UPPER_SNAKE_CASE` configuration name it quotes exists — npm scripts against `package.json`,
paths against the filesystem, variables against `src/config/env.schema.ts` — and that every
relative link resolves. A thin `scripts/verify-docs.sh` runs this plus the document checks as
one gate, exposed as `npm run docs:verify`.

**Rationale**: FR-030 and FR-033 demand enforcement, and SC-006 puts a number on it. A test is
the cheapest enforcement that already runs in CI, needs no new tooling, and fails at the
moment a script is renamed rather than the moment a new developer follows the README and
fails. Parsing, rather than a curated allow-list, is what makes it hold as the README grows.

**Deliberately not done**: this feature does **not** extend `scripts/verify-uat.sh`. That
script encodes the acceptance criteria of phases 1–9 and states in its own header what it does
and does not assert; bolting a tenth concern onto it would blur a gate that is currently
precise. `docs:verify` is a separate, separately-invocable gate, consistent with the project's
own note that later phases need their own verifier.

**Alternatives considered**:
- *A link checker only.* Rejected: broken links are the least damaging failure. A README that
  confidently names a command that no longer exists is worse, because the reader believes it.
- *Manual review.* Rejected: it is what produced a repository with no README at all.

---

## R-008 — Examples drawn from seeded data

**Decision**: Every example in the document uses the identifiers `scripts/seed.ts` creates —
the Northwind and Contoso organisation ids and their program ids — and every documented
monetary example is an integer string in minor units.

**Rationale**: SC-003 requires that an imported request executes successfully against a seeded
instance with no hand-editing beyond supplying a credential. That is only possible if the
example identifiers are the seeded ones. It also makes the examples self-checking: the
conformance spec asserts that every documented program id appears in the seed script, so a
change to the seed data that orphans an example fails the suite.

**Alternatives considered**:
- *Generic placeholder UUIDs.* Rejected: they fail SC-003 and quietly teach readers to expect
  a 404 on their first call — the worst possible first impression of an API whose refusals are
  deliberately indistinguishable from "not found".
