# Phase 1 Data Model: Configurable Log Level

**Feature**: 005-configurable-log-level | **Date**: 2026-09-22

This feature introduces no persisted entity, no table and no migration. Its single entity is a
process-scoped configuration value, modelled here because `spec.md` names it as a Key Entity.

## Entity: Log verbosity level

**Identity**: the environment variable `LOG_LEVEL`. One value per process, read once at
startup, immutable for the process lifetime.

**Storage**: none. Validated into the joi-backed config at boot and handed to pino. It is never
written to Postgres, Redis or Kafka, and never appears in a response body.

### Field

| Field | Type | Required | Default | Constraint |
|---|---|---|---|---|
| `LOG_LEVEL` | string | no | `warn` when `NODE_ENV === 'test'`, otherwise `info` | one of `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent` |

**Empty string**: coerced to "absent" before the default is applied, so `LOG_LEVEL=` takes the
default rather than failing validation.

### Ordered value set

Most verbose first. A record is emitted only when its own severity is at or above the
configured threshold.

| Value | Emits | Note |
|---|---|---|
| `trace` | everything | |
| `debug` | debug and above | |
| `info` | info and above | **today's behaviour**; includes the per-request record |
| `warn` | warn and above | **the test-run default**; drops routine 2xx request records, keeps 4xx/5xx and errors |
| `error` | error and above | |
| `fatal` | fatal only | |
| `silent` | nothing | supported, and the operator's choice |

### Which records fall where

Derived from `pino-http`'s default `customLogLevel` (see `research.md` R-005):

| Record | Severity |
|---|---|
| HTTP request completing 2xx/3xx | `info` |
| HTTP request completing 4xx | `warn` |
| HTTP request completing 5xx, or an errored request | `error` |
| Nest framework lifecycle messages (via `app.useLogger`) | `log` → `info` |

### Validation

Enforced by joi in `src/config/env.schema.ts` at boot, alongside the other 24 keys. An
unrecognised value aborts startup with joi's own message, which names both the key and the
accepted values — the behaviour every other invalid setting in this schema already has.

### State transitions

None. The value is fixed at startup; runtime reconfiguration is out of scope per `spec.md`.

## Relationships

- **`LOG_LEVEL` → pino instance**: consumed once by `LoggerModule` in `src/app.module.ts` as
  `pinoHttp.level`.
- **`LOG_LEVEL` → `NODE_ENV`**: read-only dependency. `NODE_ENV` selects the default; it never
  overrides an explicitly supplied value.
- **`LOG_LEVEL` ↔ `redact`**: none, deliberately. Redaction is unconditional at every level
  (FR-008).
