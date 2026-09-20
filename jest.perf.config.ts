import type { Config } from 'jest';
import base from './jest.config';

// Runs ONLY the performance harnesses (SC-002a, SC-003, SC-003a), which the
// default `npm test` excludes because they are a release gate, not a per-commit
// check. One worker at a time keeps each measurement free of cross-talk from a
// sibling harness and its containers.
const config: Config = {
  ...base,
  testPathIgnorePatterns: ['/node_modules/'],
  testRegex: 'test/performance/.*\\.spec\\.ts$',
  maxWorkers: 1,
};

export default config;
