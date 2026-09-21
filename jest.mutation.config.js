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
 * Plain CommonJS `.js` rather than `.ts` so Stryker's jest-runner need not resolve a
 * TypeScript config. `package.json` declares no `"type"`, so `.js` is CommonJS.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/test/unit'],
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
};
