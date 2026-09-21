# Contract: Documentation Endpoints

**Feature**: `002-openapi-docs-readme`

Two new surfaces. Neither carries tenant data; both are gated by one configuration flag.

## Routes

| Path | Method | Response | Content type |
|---|---|---|---|
| `/docs` | GET | interactive documentation page | `text/html` |
| `/docs/openapi.json` | GET | the description | `application/json` |
| `/docs/openapi.yaml` | GET | the description | `application/yaml` |

The JSON and YAML bodies are two serialisations of one in-memory document built once at
bootstrap. They must be semantically identical; a spec asserts that parsing the YAML yields a
structure deeply equal to the JSON.

## Exposure

Controlled by `API_DOCS_ENABLED`, validated in `src/config/env.schema.ts` and declared in
`.env.example`:

```
API_DOCS_ENABLED: Joi.string().valid('true', 'false')
  .default(process.env.NODE_ENV === 'production' ? 'false' : 'true')
```

| State | Behaviour |
|---|---|
| Enabled | All three paths are mounted and served. |
| Disabled | **Nothing is mounted.** The paths are not registered on the router. |

When disabled, a request to `/docs` is handled by the existing error filter as an unmatched
route and returns the identical `404` / `NOT_FOUND` body any other unknown path returns. The
refusal therefore discloses nothing about whether the feature exists or is switched off
(FR-015, SC-009).

Disabling must never require a code change or a rebuild — the flag is read from the
environment at boot.

## Authentication

**The documentation surfaces themselves require no credential.** Justified under
Constitution Principle V in `plan.md` and recorded in `docs/ASSUMPTIONS.md`: they publish the
API's contract — schemas and seeded example identifiers — and contain no organisation,
program, invoice, or ledger data.

**Requests issued from the page are not privileged.** They leave the browser as ordinary HTTP
requests and traverse the identical chain:

1. `JwtAuthGuard` — a missing or invalid token is `401`.
2. `ProgramScopeGuard` — a program the credential's organisation does not own is `404`, never
   `403`.
3. `ScopeGuard` — a credential lacking the operation's `x-required-scope` is `403`.
4. The global `ValidationPipe` — `whitelist: true`, unchanged.
5. `OrgThrottlerGuard` — the same per-organisation read and write budgets.

A spec asserts each of these against a request issued at a documented path, so the page
cannot become a bypass (FR-016, SC-010).

## Performance

The document is built once during bootstrap and cached for the process lifetime. It is never
rebuilt per request. Bootstrap must not lengthen by more than ~250ms; serving the description
must add no measurable latency to any API request.

## Non-goals

- No hosted or external documentation portal.
- No versioned archive of past documents.
- No write path, no persistence, no migration.
