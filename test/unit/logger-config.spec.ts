import type { ObjectSchema } from 'joi';
import { buildPinoHttpOptions } from '../../src/config/logger.config';

const VALID_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  KAFKA_BROKERS: 'localhost:9093',
  KAFKA_SASL_USERNAME: 'u',
  KAFKA_SASL_PASSWORD: 'p',
  JWT_SECRET: 'x'.repeat(32),
} as const;

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;

const OPTS = { abortEarly: false, allowUnknown: true } as const;

// Re-imports env.schema.ts under a chosen NODE_ENV, because its default is
// computed at module load and cannot be varied any other way.
const schemaUnder = (nodeEnv: string): ObjectSchema => {
  jest.resetModules();
  process.env.NODE_ENV = nodeEnv;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
  return require('../../src/config/env.schema').envSchema as ObjectSchema;
};

const validateWith = (schema: ObjectSchema, overrides: Record<string, unknown> = {}) =>
  schema.validate({ ...VALID_ENV, ...overrides }, OPTS);

describe('LOG_LEVEL', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('accepts every supported level', () => {
    const schema = schemaUnder('test');
    for (const level of LEVELS) {
      const { error, value } = validateWith(schema, { LOG_LEVEL: level });
      expect(error).toBeUndefined();
      expect(value.LOG_LEVEL).toBe(level);
    }
  });

  it("rejects 'verbose', naming LOG_LEVEL and every accepted value", () => {
    const schema = schemaUnder('test');
    const { error } = validateWith(schema, { LOG_LEVEL: 'verbose' });
    expect(error).toBeDefined();
    expect(error?.message).toContain('LOG_LEVEL');
    for (const level of LEVELS) {
      expect(error?.message).toContain(level);
    }
  });

  it('treats an empty value as the default rather than an error', () => {
    const schema = schemaUnder('test');
    const { error, value } = validateWith(schema, { LOG_LEVEL: '' });
    expect(error).toBeUndefined();
    expect(value.LOG_LEVEL).toBe('warn');
  });

  it("defaults to 'warn' when NODE_ENV is test", () => {
    const schema = schemaUnder('test');
    const { error, value } = validateWith(schema);
    expect(error).toBeUndefined();
    expect(value.LOG_LEVEL).toBe('warn');
  });

  it("defaults to 'info' when NODE_ENV is production", () => {
    const schema = schemaUnder('production');
    const { error, value } = validateWith(schema);
    expect(error).toBeUndefined();
    expect(value.LOG_LEVEL).toBe('info');
  });

  it('lets an explicit level beat the default', () => {
    const schema = schemaUnder('test');
    const { error, value } = validateWith(schema, { LOG_LEVEL: 'trace' });
    expect(error).toBeUndefined();
    expect(value.LOG_LEVEL).toBe('trace');
  });
});

describe('buildPinoHttpOptions', () => {
  it('uses the supplied level verbatim', () => {
    for (const level of LEVELS) {
      expect(buildPinoHttpOptions(level).level).toBe(level);
    }
  });

  it('redacts the same paths whatever the level', () => {
    expect(buildPinoHttpOptions('error').redact).toEqual(buildPinoHttpOptions('trace').redact);
    expect(buildPinoHttpOptions('error').redact).toEqual({
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
      ],
      censor: '[redacted]',
    });
  });

  it('keeps the correlation and level-format hooks', () => {
    const opts = buildPinoHttpOptions('info');
    expect(typeof opts.genReqId).toBe('function');
    expect(typeof opts.customProps).toBe('function');
    expect(typeof (opts.formatters as { level?: unknown } | undefined)?.level).toBe('function');
  });
});
