/**
 * Jest configuration used only by Stryker (`npm run test:mutation`).
 *
 * `roots` is restricted to `test/unit` as a STRUCTURAL exclusion of the
 * container-dependent suites, not a subtractive ignore pattern. `npm run test:unit`
 * gets its Docker-free property from a command-line path argument (`jest test/unit`),
 * which Stryker never runs — so reusing `jest.config.ts` here would silently pull the
 * testcontainers-backed suites into every mutant run. See research R-002.
 *
 * `coverageThreshold` is deliberately omitted: the 80% global gate belongs to
 * `npm run test:cov` alone and must not be evaluated per mutant.
 *
 * `testPathIgnorePatterns` excludes exactly one spec. test/unit/no-auto-expiry.spec.ts
 * reads every file under src/ as raw text and asserts over its lines; Stryker's
 * instrumenter reprints those files in its sandbox, collapsing two constants in
 * src/capacity/domain/errors.ts onto a single line and tripping the assertion. The test
 * is correct, the source is correct, and Stryker is correct — a test that asserts over
 * source text cannot compose with a tool whose method is rewriting source text. This
 * exclusion applies to the mutation run ONLY: npm run test:unit, npm test and
 * npm run test:cov continue to run that spec unchanged. See research R-010.
 *
 * Plain CommonJS `.js` rather than `.ts` so Stryker's jest-runner need not resolve a
 * TypeScript config. `package.json` declares no `"type"`, so `.js` is CommonJS.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/test/unit'],
  testRegex: '.*\\.spec\\.ts$',
  testPathIgnorePatterns: ['/node_modules/', 'test/unit/no-auto-expiry\\.spec\\.ts$'],
  moduleFileExtensions: ['js', 'json', 'ts'],
};
