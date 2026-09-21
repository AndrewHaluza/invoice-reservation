# Phase 1 Data Model: API Documentation & Project README

**Feature**: `002-openapi-docs-readme` | **Date**: 2026-09-21

These are **description structures**, not persisted ones. This feature adds no table, no
entity, and no migration. What follows defines the shape of the document the service
publishes and the classes that produce it.

---

## 1. OpenAPI Document

The single artefact describing the whole HTTP surface. Built once at bootstrap from the
initialised application and cached for the process lifetime.

| Field | Value | Source of truth |
|---|---|---|
| `openapi` | `3.1.0` | `openapi-metadata.ts` |
| `info.title` | `Program Capacity & Invoice Reservation API` | `openapi-metadata.ts` |
| `info.version` | read from `package.json` `version` | `package.json` |
| `info.description` | purpose, the bearer-token rule, and the non-disclosure rule (out-of-scope programs resolve to 404, never 403) | `openapi-metadata.ts` |
| `servers[0].url` | `http://localhost:${PORT}` | resolved at bootstrap from configuration |
| `security` | `[{ bearerAuth: [] }]` — the document default | `openapi-metadata.ts` |
| `tags` | `capacity`, `audit`, `health` | `openapi-metadata.ts` |
| `components.securitySchemes.bearerAuth` | `http` / `bearer` / `JWT` | `openapi-metadata.ts` |
| `paths` | derived from the router | the controllers |
| `components.schemas` | derived from decorated DTO classes | the DTOs |

**Validation rules**
- Must validate against the OpenAPI 3.1 meta-schema with zero errors (FR-003, SC-004).
- Must be self-contained: no external `$ref`, no `$ref` to a file (FR-001).
- Every `paths` entry must carry `operationId`, `summary`, and at least one example
  (FR-008, FR-014, SC-007).

---

## 2. Operation

One callable action. Eight exist.

| Field | Meaning | Rule |
|---|---|---|
| `path` + `method` | route identity | must match a live route exactly |
| `operationId` | stable machine name | unique; must equal the 001 contract's |
| `summary` | business-language sentence | must not merely restate the path (FR-014) |
| `tags` | grouping area | exactly one of `capacity`, `audit`, `health` (FR-013) |
| `x-required-scope` | permission the credential must carry | absent only on the health operations |
| `security` | `[]` on health, inherited otherwise | health is the only credential-free pair (FR-010) |
| `parameters` | path, query, headers | each with type and constraints (FR-004) |
| `requestBody` | schema with field constraints | writes only |
| `responses` | every status the operation can return | including refusals (FR-004, FR-005) |

**The eight operations**

| # | Method + path | `operationId` | Tag | Scope |
|---|---|---|---|---|
| 1 | `POST /v1/programs/{programId}/reservations` | `createReservation` | capacity | `capacity:write` |
| 2 | `POST /v1/programs/{programId}/reservations/{invoiceId}/releases` | `createRelease` | capacity | `capacity:write` |
| 3 | `POST /v1/programs/{programId}/reservations/{invoiceId}/cancellation` | `cancelReservation` | capacity | `capacity:write` |
| 4 | `GET /v1/programs/{programId}/availability` | `getAvailability` | capacity | `capacity:read` |
| 5 | `GET /v1/programs/{programId}/reservations` | `listReservations` | capacity | `capacity:read` |
| 6 | `GET /v1/programs/{programId}/reservations/{invoiceId}` | `getReservation` | capacity | `capacity:read` |
| 7 | `GET /v1/programs/{programId}/ledger` | `getLedger` | audit | `capacity:audit` |
| 8 | `GET /health/live`, `GET /health/ready` | `getLiveness`, `getReadiness` | health | — (none) |

Row 8 is two operations; the table groups them because they share every other attribute.
Nine `operationId`s therefore exist in total.

---

## 3. Money

The representation that Principle I makes non-negotiable, and the single most important
thing the document must get right.

```
Money:
  type: object
  required: [amountMinor, currency]
  properties:
    amountMinor:
      type: string
      pattern: '^[0-9]+$'
      description: Integer amount in the currency's minor units. A string, never a
                   number, because values exceed what a 64-bit float represents exactly.
      example: '150000'
    currency:
      type: string
      pattern: '^[A-Z]{3}$'
      description: ISO-4217 code. Always explicit; never implied by the program.
      example: USD
```

`PositiveMoney` narrows `amountMinor` to `^[1-9][0-9]{0,18}$`, mirroring `PositiveMoneyDto`.

**Validation rules**
- No schema anywhere in the document may type a monetary field as `number` or `integer`
  (FR-007, SC-008). Enforced by `test/unit/openapi-money-typing.spec.ts`, which walks every
  schema and fails on any property whose name matches a monetary pattern and whose type is
  numeric.
- Every monetary object carries its own `currency`. No monetary amount appears as a bare
  scalar.

---

## 4. Error

The single refusal shape shared by every operation (FR-005).

```
Error:
  type: object
  required: [code, message]
  properties:
    code:     { type: string, description: Machine-readable. Branch on this, never on message. }
    message:  { type: string, description: Fixed human-readable prose. Never interpolates an
                                           amount, identifier, or program id. }
    details:  { type: object, additionalProperties: true, description: Optional per-field detail.
                                                                       At most 20 entries. }
```

**Codes and statuses**, taken from `src/capacity/api/error.filter.ts` — the conformance spec
asserts the documented set matches the filter's maps exactly, so a new refusal code cannot
ship undocumented:

| Status | Codes |
|---|---|
| 400 | `VALIDATION_FAILED`, `INVALID_AMOUNT` |
| 401 | `UNAUTHORIZED` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND` |
| 405 | `METHOD_NOT_ALLOWED` |
| 406 | `NOT_ACCEPTABLE` |
| 409 | `INSUFFICIENT_CAPACITY`, `PROGRAM_OVER_LIMIT`, `DUPLICATE_INVOICE`, `IDEMPOTENCY_CONFLICT`, `IDEMPOTENCY_EXPIRED`, `REQUEST_IN_FLIGHT`, `FX_RATE_UNAVAILABLE`, `AMOUNT_ROUNDS_TO_ZERO`, `CURRENCY_MISMATCH`, `RESERVATION_TERMINAL`, `RELEASE_EXCEEDS_RESERVED`, `CONFLICT` |
| 429 | rate limited |
| 503 | `POSITION_UNVERIFIED` |

**Non-disclosure rule** (FR-020, Principle V): the documentation must state that a program
outside the caller's scope resolves to `404 NOT_FOUND`, never `403`, and no example may
contradict this. `403 FORBIDDEN` is documented as meaning *the credential lacks the required
scope*, which is a statement about the credential and discloses nothing about any program.

---

## 5. Request bodies

Mirrors of the existing DTOs, decorated rather than redefined.

| Class | Fields | Constraints documented |
|---|---|---|
| `CreateReservationDto` | `invoiceId`, `amount` | `invoiceId` 1–128 chars; `amount` is `PositiveMoney` |
| `CreateReleaseDto` | `amount` | `PositiveMoney` |
| `CancellationDto` | `reason`, `note?` | `reason` ∈ `CANCELLED` \| `WRITTEN_OFF`; `note` ≤ 512 chars |

---

## 6. Headers

| Header | Operations | Documented as |
|---|---|---|
| `Authorization` | all but health | `Bearer <token>`; required |
| `Idempotency-Key` | the three writes | **required**, 8–128 characters. A replay with identical content returns the original outcome; a replay with differing content is refused `409 IDEMPOTENCY_CONFLICT` (FR-017) |
| `X-Correlation-Id` | all | optional; echoed; propagated to logs |

---

## 7. Pagination

Applies to `listReservations` and `getLedger` (FR-019).

| Element | Shape |
|---|---|
| Request | `limit` (integer, 1–200, optional), `cursor` (opaque string, optional), `status` (enum, `listReservations` only) |
| Response | `{ items: [...], nextCursor: string \| null }` |

The cursor is documented as **opaque**: clients must pass it back verbatim and must not parse
or construct one. `status` enumerates `ACTIVE`, `PARTIALLY_RELEASED`, `FULLY_RELEASED`,
`CANCELLED`, `WRITTEN_OFF`.

---

## 8. Rate limiting

Documented per FR-018: two independent per-organisation budgets — reads
`RATE_LIMIT_READ_PER_MINUTE` (default 600/min) and writes `RATE_LIMIT_WRITE_PER_MINUTE`
(default 120/min). Each operation counts against exactly one budget. Exceeding it returns
`429` with the standard `Error` body. The document states that the budget is per calling
organisation, so one tenant's traffic cannot exhaust another's.

---

## 9. Response classes

New classes under `src/capacity/api/response/`, existing only to carry documentation
metadata.

| Class | Mirrors |
|---|---|
| `AvailabilityResponse` | `AvailabilityBody` |
| `ReservationResponse` | `ReservationBody` |
| `ReserveResponse`, `ReleaseResponse`, `CancelResponse` | `ReserveBody`, `ReleaseBody`, `CancelBody` |
| `LedgerEntryResponse` | the audit read row |
| `PageResponse<T>` | `Page<T>` |
| `ErrorResponse` | the error filter's body |

**Rule**: each class carries a compile-time assertion that it is assignable to the
application body type it mirrors. A field added to a body type without a matching field on
the response class is a type error at build time — not a documentation lie discovered by an
integrator.

---

## 10. Documentation areas (tags)

| Tag | Operations | Description |
|---|---|---|
| `capacity` | 1–6 | Reserve, release, cancel, and read a program's position |
| `audit` | 7 | Read the append-only ledger behind a program's position |
| `health` | 8 | Liveness and readiness probes; no credential required |

---

## Relationships

```
OpenAPI Document
├── info, servers, security, tags
├── Operation  ×9
│   ├── parameters ─── Headers, path params, pagination query
│   ├── requestBody ── Request DTO ── Money / PositiveMoney
│   └── responses ──┬─ Response class ── Money, Page
│                   └─ Error ── code + status table (oracle: error.filter.ts)
└── components.schemas ── every class above

Oracles (assertion targets, not inputs):
  specs/001-program-capacity-reservation/contracts/http-api.yaml  → operations, scopes, statuses
  src/capacity/api/error.filter.ts                                → codes and statuses
  scripts/seed.ts                                                 → example identifiers
  src/config/env.schema.ts                                        → README's variable names
```
