// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: 'npm',

  // Scope: the six defended business-logic directories (FR-001), then the eight
  // exclusions (FR-002). The exclusions remove zero files from within these six
  // directories as measured on 2026-09-21; they are kept because the globs are
  // evaluated against future contents and a `dto/` folder under
  // `src/capacity/application/` is plausible. See research R-009.
  mutate: [
    'src/capacity/domain/**/*.ts',
    'src/capacity/application/**/*.ts',
    'src/shared/money/**/*.ts',
    'src/shared/result/**/*.ts',
    'src/treasury/handlers/**/*.ts',
    'src/treasury/retry/**/*.ts',
    '!src/migrations/**',
    '!src/config/**',
    '!src/types/**',
    '!src/main.ts',
    '!**/*.module.ts',
    '!**/entities/**',
    '!**/dto/**',
    '!src/observability/**',
  ],

  testRunner: 'jest',
  jest: {
    // NOT jest.config.ts — that config's `roots` include test/integration, which is
    // testcontainers-backed. See jest.mutation.config.js and research R-002.
    configFile: 'jest.mutation.config.js',
  },

  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',

  coverageAnalysis: 'perTest',

  reporters: ['html', 'clear-text', 'progress'],
  htmlReporter: { fileName: 'reports/mutation/mutation.html' },

  incremental: true,
  incrementalFile: '.stryker-incremental.json',

  timeoutMS: 10000,

  // Derived arithmetically from the measured baseline in
  // specs/003-mutation-testing/baseline.md, per contract C-2.5. `break` alone governs
  // exit status; `high` and `low` are report colouring and aspiration only (FR-010).
  thresholds: { high: 45, low: 40, break: 38 },

  // `concurrency` is deliberately left at the Stryker default. A laptop and a 2-4 vCPU
  // GitHub runner want different values and pinning one penalises the other.
};
