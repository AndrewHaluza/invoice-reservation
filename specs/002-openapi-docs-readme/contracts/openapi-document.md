# Contract: The Served OpenAPI Document

**Feature**: `002-openapi-docs-readme`

What the generated document must contain. This is the checklist
`test/contract/openapi-conformance.contract.spec.ts` encodes.

## A. Document-level

| # | Assertion | Requirement |
|---|---|---|
| A1 | `openapi` is `3.1.0` | FR-001 |
| A2 | Validates against the OpenAPI 3.1 meta-schema, zero errors | FR-003, SC-004 |
| A3 | Self-contained — no external or file `$ref` | FR-001 |
| A4 | `info` has `title`, `version`, and a `description` naming the service's purpose | FR-009 |
| A5 | `servers[0].url` resolves against a locally running instance | FR-009 |
| A6 | `components.securitySchemes.bearerAuth` is `http` / `bearer` / `JWT`; document-level `security` requires it | FR-006 |
| A7 | `tags` are exactly `capacity`, `audit`, `health` | FR-013 |
| A8 | YAML and JSON serialisations parse to deeply equal structures | — |

## B. Operation coverage — the drift gate

| # | Assertion | Requirement |
|---|---|---|
| B1 | Every path-and-method pair the live router serves appears in the document | FR-002, FR-031, SC-002 |
| B2 | Every path-and-method pair in the document is served by the live router | FR-031, SC-002 |
| B3 | The document's path-and-method set equals the 001 contract's | FR-031 |
| B4 | `operationId`s match the 001 contract's, one for one | — |
| B5 | Each operation's `x-required-scope` matches the 001 contract's | FR-006 |
| B6 | Each operation's response status set matches the 001 contract's | FR-004 |
| B7 | Every operation has a non-empty `summary` that is not a restatement of its path | FR-014, SC-007 |
| B8 | Every operation belongs to exactly one tag | FR-013 |

B1 and B2 are asserted against the router the application actually exposes, not against a
list. B3–B6 are asserted against `specs/001-program-capacity-reservation/contracts/http-api.yaml`.
Together they make an undocumented endpoint, a documented phantom, and a design drift each an
independent test failure.

## C. Money

| # | Assertion | Requirement |
|---|---|---|
| C1 | No schema property whose name matches a monetary pattern is typed `number` or `integer` | FR-007, SC-008 |
| C2 | Every monetary object requires both `amountMinor` and `currency` | FR-007 |
| C3 | `amountMinor` is `type: string` with an integer `pattern` and a string example | FR-007 |
| C4 | `currency` is `type: string`, `^[A-Z]{3}$` | FR-007 |

C1 walks every schema in `components.schemas` rather than a curated list, so a monetary field
added to a new DTO is caught without the test being updated.

## D. Errors

| # | Assertion | Requirement |
|---|---|---|
| D1 | An `Error` schema exists with required `code` and `message`, optional `details` | FR-005 |
| D2 | The documented code set equals `error.filter.ts`'s refusal-code set | FR-005 |
| D3 | Each documented code's status equals the filter's mapping | FR-005 |
| D4 | Every non-health operation documents `401`, `403`, `404`, and `429` | FR-004 |
| D5 | Each write operation documents `409` with the refusal codes it can raise | FR-004, FR-017 |
| D6 | `POSITION_UNVERIFIED` is documented as `503` | FR-005 |
| D7 | The `404` description states that an out-of-scope program is indistinguishable from a missing one; `403` is described as a scope failure only | FR-020, Principle V |

## E. Idempotency

| # | Assertion | Requirement |
|---|---|---|
| E1 | All three write operations declare `Idempotency-Key` as a **required** header | FR-017 |
| E2 | Its documented constraint is 8–128 characters | FR-017 |
| E3 | The description states that a matching replay returns the original outcome | FR-017 |
| E4 | The description states that a differing replay is refused `409 IDEMPOTENCY_CONFLICT` | FR-017 |
| E5 | `createReservation` documents both `201` (created) and `200` (replayed) | FR-004 |

## F. Pagination

| # | Assertion | Requirement |
|---|---|---|
| F1 | `listReservations` and `getLedger` document `limit` (1–200) and `cursor` | FR-019 |
| F2 | Their responses document `items` and `nextCursor` | FR-019 |
| F3 | `cursor` is documented as opaque — passed back verbatim, never parsed or constructed | FR-019 |
| F4 | `listReservations` documents the five `status` enum values | FR-019 |

## G. Rate limiting

| # | Assertion | Requirement |
|---|---|---|
| G1 | The document states both per-organisation budgets and their defaults | FR-018 |
| G2 | Every rate-limited operation documents `429` with the `Error` body | FR-018 |
| G3 | The document states the budget is per calling organisation | FR-018 |

## H. Health

| # | Assertion | Requirement |
|---|---|---|
| H1 | `GET /health/live` and `GET /health/ready` appear under the `health` tag | FR-010 |
| H2 | Both declare `security: []` — explicitly no credential | FR-010 |
| H3 | Neither declares an `x-required-scope` | FR-010 |

## I. Examples

| # | Assertion | Requirement |
|---|---|---|
| I1 | Every operation carries at least one request example (where it takes a body) and one response example | FR-008, SC-007 |
| I2 | Every example program and organisation id appears in `scripts/seed.ts` | FR-008, SC-003 |
| I3 | Every example monetary amount is a string of digits | FR-007 |
| I4 | Example `Idempotency-Key` values satisfy the 8–128 constraint | FR-017 |

## J. Import fitness

| # | Assertion | Requirement |
|---|---|---|
| J1 | Every operation has a unique `operationId` — clients name generated requests from it | FR-002 |
| J2 | `bearerAuth` is declared at document level so a client sets the credential once | FR-011, SC-003 |
| J3 | No vendor extension is load-bearing: stripping every `x-` key leaves a valid, complete document | SC-003 |

J3 matters because `x-required-scope` is this project's own extension. Clients that ignore
unknown extensions must still import a complete, runnable collection.
