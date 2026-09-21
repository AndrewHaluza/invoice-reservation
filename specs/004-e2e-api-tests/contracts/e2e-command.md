# Contract: The `test:e2e` Command

**Feature**: 004-e2e-api-tests | **Date**: 2026-09-21

The interface this feature exposes is a command. This is what it promises.

---

## C-1 Invocation

```bash
npm run test:e2e
```

- **C-1.1** Resolves to `jest --config jest.e2e.config.ts`, matching the form of the
  existing `test:recovery` and `test:perf` scripts.
- **C-1.2** Takes no required argument. Standard Jest flags pass through
  (`-- -t '<name>'`, `--runInBand`).
- **C-1.3** Runs from a clean checkout after `npm ci`, with no build step first.

## C-2 Exit status

- **C-2.1** `0` when every scenario passes.
- **C-2.2** Non-zero when any scenario fails. No scenario may be skipped to keep the
  command green.
- **C-2.3** A missing container runtime exits non-zero with a message naming the missing
  prerequisite — not a timeout and not a bare connection error.

## C-3 Scope

- **C-3.1** Runs exactly the files matching `test/e2e/.*\.spec\.ts$` and nothing else.
- **C-3.2** Runs no file under `test/unit`, `test/integration`, `test/migration`,
  `test/contract` or `test/performance`.
- **C-3.3** Collects no coverage and enforces no coverage threshold. The 80% gate stays
  with `npm run test:cov`, over the files it already measures.

## C-4 Isolation from every existing command

The heart of FR-011. Each of these must behave as it does today, verified by comparing a
run before and after.

| Command | Promise |
|---|---|
| `npm test` | Runs the same file set as before. `test/e2e/` is excluded in `jest.config.ts`. |
| `npm run test:unit` | Unchanged — it passes `test/unit` as a path argument. |
| `npm run test:cov` | Same files, same thresholds, same reported percentages. |
| `npm run test:recovery` | Unchanged — its own config pins one file by regex. |
| `npm run test:perf` | Unchanged — its own config. |
| `npm run test:mutation` | Unchanged. `jest.mutation.config.js` roots at `test/unit`, so `test/e2e/` is invisible to it and the baseline score cannot move. |
| `npm run typecheck` | Passes. The new files are type-checked like every other test file. |
| `npm run lint` | Passes with no new ignore entry. |
| `npm run build` | Unchanged — `tsconfig.build.json` excludes tests. |
| `npm run docs:verify` | Unchanged — it names four unit specs explicitly. |

- **C-4.1** `git diff` on `jest.mutation.config.js`, `stryker.config.mjs`,
  `jest.recovery.config.ts`, `jest.perf.config.ts` and `package-lock.json` must be empty.
- **C-4.2** The only change to `jest.config.ts` is one added `testPathIgnorePatterns`
  entry. Nothing else in that file may move.

## C-5 Environment

- **C-5.1** Requires a reachable container runtime. Postgres and Redis containers start
  per spec file through `test/support/postgres-container.ts` and
  `test/support/redis-container.ts`.
- **C-5.2** Starts **no** Redpanda container. The inbound treasury path is exercised by
  handing a message to the handler, not by publishing to a topic (R-001).
- **C-5.3** Binds no fixed port. Containers take ephemeral ports and the application is
  started with `listen(0)`. Nothing may hardcode 5432, 6379 or 9092 — karst allocates per
  worktree.
- **C-5.4** Every environment variable the suite sets is restored on teardown, so a failing
  run does not poison a later one in the same process.

## C-6 Output on failure

- **C-6.1** Names the failing scenario, the expected and actual HTTP status, and the
  response `code`.
- **C-6.2** Never prints a token, a connection string or a password.
- **C-6.3** Is actionable without re-running under a debugger (FR-016).

## C-7 Budget

- **C-7.1** Completes in under **5 minutes** on `ubuntu-latest` (SC-004).
- **C-7.2** If it exceeds that, the fix is to share fixtures within a file — never to drop
  a scenario or to weaken an assertion.
