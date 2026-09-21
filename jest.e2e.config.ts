import type { Config } from 'jest';
import base from './jest.config';

// Runs ONLY the end-to-end API suite, which the default `npm test` excludes
// because every scenario boots the whole application against its own
// Postgres and Redis containers. Keeping it out of the default run also
// keeps it out of the 80% coverage gate, which measures `src/` only.
const config: Config = {
  ...base,
  testPathIgnorePatterns: ['/node_modules/'],
  testRegex: 'test/e2e/.*\\.spec\\.ts$',
};

export default config;
