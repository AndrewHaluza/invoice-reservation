# Quickstart: Validating API Documentation & README

**Feature**: `002-openapi-docs-readme` | **Date**: 2026-09-21

How to prove this feature works end to end, once implemented. Each scenario maps to a user
story and its success criteria. See [contracts/](./contracts/) for what the document must
contain and [data-model.md](./data-model.md) for the shapes.

## Prerequisites

- Node.js 22.x (`>=22.0.0 <23`)
- A running Docker daemon — needed by the integration and conformance suites, and by the
  local stack
- A clean clone, for Scenario 5

Ports are allocated per worktree. Never assume 3000, 5432, 6379, or 9092:

```bash
./scripts/dev-stack.sh env          # prints the resolved set
eval "$(./scripts/dev-stack.sh env | sed 's/^/export /')"
```

## Setup

```bash
./scripts/dev-stack.sh              # stack + migrations + seed + API
```

The seed writes one credential per organisation to stdout. Capture the Northwind token and a
program id:

```bash
TOKEN=$(npm run seed --silent | sed -n '2s/^token=//p')
PROG=b1b2c3d4-0001-4000-8000-000000000011    # Northwind USD
```

---

## Scenario 1 — Browse the interactive reference (US1, SC-001, SC-007)

```bash
open "http://localhost:$PORT/docs"
```

**Expected**

- The page lists all nine operations, grouped under `capacity`, `audit`, and `health`.
- Each operation shows a business-language summary, not a restated path.
- Each capacity and audit operation shows its required scope.
- The three write operations show `Idempotency-Key` as **required**, 8–128 characters, and
  describe both replay outcomes.
- Every monetary field reads as a string of digits with a sibling currency — nowhere a number.
- `404` is described as covering both a missing program and one outside the caller's scope.

**Then**, in the page: paste `$TOKEN` into Authorize once, execute `getAvailability` with
`$PROG`, and confirm a `200` with a position body.

**Fails if** any operation is missing, any summary merely echoes its path, or any monetary
field renders as a number.

---

## Scenario 2 — Export and validate the description (US2, SC-004)

```bash
curl -s "http://localhost:$PORT/docs/openapi.json" -o /tmp/openapi.json
curl -s "http://localhost:$PORT/docs/openapi.yaml" -o /tmp/openapi.yaml

node -e "console.log(require('/tmp/openapi.json').openapi)"        # -> 3.1.0
grep -c '\$ref: *"http' /tmp/openapi.yaml || true                   # -> 0, no external refs
```

Validate against the OpenAPI 3.1 meta-schema:

```bash
npm run docs:verify
```

**Expected**: `3.1.0`; no external `$ref`; zero validation errors; no warning about missing
required metadata.

---

## Scenario 3 — Import into an API client (US2, SC-003)

Import `/tmp/openapi.json` into two mainstream API clients (for example Postman and
Insomnia).

**Expected**

- Import completes with no errors.
- Each of the nine operations appears as a runnable request with its path, parameters,
  headers, and an example body.
- Setting the bearer token **once** at collection level authorises every request — no
  per-request configuration.
- Executing `getAvailability` against the seeded instance returns `200` **with no hand-editing
  of any request**, because the example ids are the seeded ones.
- Executing `createReservation` with its example body returns `201`.

**Fails if** any request needs a hand-typed path, header, or identifier before it runs.

---

## Scenario 4 — The page grants no extra access (SC-010, FR-016)

```bash
# no credential
curl -s -o /dev/null -w '%{http_code}\n' \
  "http://localhost:$PORT/v1/programs/$PROG/availability"                      # -> 401

# valid credential, program owned by the other organisation
CONTOSO_PROG=b1b2c3d4-0003-4000-8000-000000000013
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  "http://localhost:$PORT/v1/programs/$CONTOSO_PROG/availability"              # -> 404, never 403
```

**Expected**: `401` then `404`. The `404` is the non-disclosure rule holding — a credential
must not learn whether another organisation's program exists.

**Then** repeat both from inside the documentation page. The responses must be identical: the
page is a client, not a bypass.

---

## Scenario 5 — Clean-clone onboarding (US3, SC-005, SC-006)

On a machine with only the stated prerequisites:

```bash
git clone <repository> && cd invoice-reservation
```

Follow `README.md` literally, consulting nothing else, until a first API call returns success.

**Expected**

- Under 15 minutes, no questions asked of anyone.
- The readiness probe reports healthy.
- The first-call walkthrough yields a credential and sample ids from the documented output,
  and a real operation returns a success response.
- How to run the tests, where the layered structure is described, and where the interactive
  documentation lives are each stated or linked.
- No secret value appears anywhere in the README.

Then confirm it stays true:

```bash
npm run docs:verify
```

**Expected**: every command, path, and configuration name quoted in the README exists; every
relative link resolves.

**Fails if** the README names an npm script, a file, or an environment variable that does not
exist — this is the check that keeps Scenario 5 reproducible six months from now.

---

## Scenario 6 — Exposure is controllable (FR-015, SC-009)

```bash
API_DOCS_ENABLED=false ./scripts/dev-stack.sh
curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:$PORT/docs"              # -> 404
curl -s "http://localhost:$PORT/docs/openapi.json" | head -c 200                    # -> NOT_FOUND body
curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:$PORT/nonexistent-path"  # -> 404
```

**Expected**: the two bodies are **indistinguishable**. A disabled documentation surface must
look exactly like any other unknown path, or the refusal itself discloses the feature.

Then confirm the API is unaffected:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  "http://localhost:$PORT/v1/programs/$PROG/availability"                           # -> 200
```

---

## Automated verification

```bash
npm run typecheck && npm run lint     # strict TS + the boundary matrix, incl. the new element
npm run test:unit                     # Docker-free: money typing, metadata, README references
npm test                              # + conformance (generated vs. 001 contract) and serving
npm run test:cov                      # 80% global threshold
npm run docs:verify                   # the documentation gate on its own
./scripts/verify-uat.sh               # phases 1–9, unchanged by this feature
```

**All must pass.** `npm run docs:verify` is the gate this feature adds; `verify-uat.sh` is
deliberately left untouched, and its passing unchanged is itself a check that nothing in the
existing contract moved.

## What would falsify the feature

- An endpoint exists in the router but not in the document, or the reverse — the conformance
  spec must already have failed.
- A monetary field typed as a number anywhere in the document.
- An imported request that needs hand-editing before it runs.
- A README command that does not exist.
- A disabled documentation surface that answers differently from an unknown path.
