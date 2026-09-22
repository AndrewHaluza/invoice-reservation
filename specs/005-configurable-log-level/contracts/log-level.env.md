# Contract: `LOG_LEVEL` environment setting

**Feature**: 005-configurable-log-level

The only external interface this feature exposes is an environment variable. There is no new
HTTP route, no new message and no schema change, so `contracts/` holds this one document.

## Declaration

Declared in **both** of, and in the same commit:

- `src/config/env.schema.ts` — the joi schema that validates the environment at boot.
- `.env.example` — the published template.

`scripts/verify-uat.sh` section 6 asserts the two key sets are identical and fails UAT on
drift. Adding the key to only one of them turns the gate red.

### Schema entry

```ts
LOG_LEVEL: Joi.string()
  .valid('trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent')
  .empty('')
  .default(process.env.NODE_ENV === 'test' ? 'warn' : 'info'),
```

`.empty('')` is required: a bare `Joi.string()` rejects `''`, so without it `LOG_LEVEL=` would
fail validation instead of taking the default. Its position relative to `.default(...)` does not
matter — both orders behave identically in joi 18.2.9.

### Template entry

```dotenv
# Log verbosity: trace | debug | info | warn | error | fatal | silent
# Defaults to info; a test run defaults to warn. Raise for one run with:
#   LOG_LEVEL=info npm test
LOG_LEVEL=info
```

## Behaviour

| Supplied value | Result |
|---|---|
| absent, `NODE_ENV` not `test` | `info` — identical to today |
| absent, `NODE_ENV=test` | `warn` — routine per-request records suppressed |
| empty string | as absent |
| a recognised level | that level, in every environment |
| anything else | **boot is refused** with `Config validation error: "LOG_LEVEL" must be one of [trace, debug, info, warn, error, fatal, silent]` |

## Consumption

```ts
// src/config/logger.config.ts
export const buildPinoHttpOptions = (level: string) => ({
  level,
  genReqId,      // unchanged
  customProps,   // unchanged
  redact,        // unchanged, and independent of `level`
  formatters,    // unchanged
});

// src/app.module.ts
LoggerModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    pinoHttp: buildPinoHttpOptions(config.getOrThrow<string>('LOG_LEVEL')),
  }),
}),
```

`redact` is unchanged and unconditional. The level governs whether a record is emitted; it
never governs whether a field within an emitted record is censored.

## Compatibility

Additive and backward compatible. Any existing environment that sets nothing keeps today's
verbosity exactly. No deployment ordering constraint, no rollback step: reverting the commit
restores the previous fixed `info` behaviour, and a stale `LOG_LEVEL` left in an environment is
simply ignored by the older build.
