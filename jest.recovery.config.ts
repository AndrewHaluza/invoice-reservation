import type { Config } from 'jest';
import base from './jest.config';

// Runs ONLY the ledger recovery proof, which the default `npm test` excludes
// because it rebuilds and restores the database from a physical backup.
const config: Config = {
  ...base,
  testPathIgnorePatterns: ['/node_modules/'],
  testRegex: 'test/integration/ledger-recovery\\.spec\\.ts$',
};

export default config;
