# Pre-change baseline for feature 004

Recorded before any file was created under `test/e2e/`, on 2026-09-21, commit `9c6e6adcd2a60bf100488068efa91dc99d212fb9`.
Task 11 (`tasks.md` T025) re-runs both commands and compares. A changed number means the
`test/e2e/` entry in `jest.config.ts` `testPathIgnorePatterns` is missing and the suite
has joined the default run, breaching FR-011.

## `npm test`

- Test Suites: 70 passed, 70 total
- Tests: 516 passed, 516 total

## `npm run test:cov`

- Statements: 95.71%
- Branches: 84.37%
- Functions: 93.82%
- Lines: 95.65%
