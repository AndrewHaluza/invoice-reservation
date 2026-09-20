import {
  PermanentTreasuryError,
  RetryExhaustedError,
  classifyFailure,
  withRetry,
} from '../../src/treasury/retry/failure-classifier';

describe('classifyFailure', () => {
  it('classifies a PermanentTreasuryError as permanent', () => {
    expect(classifyFailure(new PermanentTreasuryError('nope'))).toBe('PERMANENT');
  });

  it('classifies a Postgres SQLSTATE transient code as transient', () => {
    expect(classifyFailure(Object.assign(new Error('lock'), { code: '55P03' }))).toBe(
      'TRANSIENT',
    );
  });

  it('classifies a network code as transient', () => {
    expect(classifyFailure(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(
      'TRANSIENT',
    );
  });

  it('reads the code from a wrapped cause', () => {
    expect(
      classifyFailure(new Error('wrap', { cause: Object.assign(new Error('inner'), { code: '40001' }) })),
    ).toBe('TRANSIENT');
  });

  it('classifies an unknown error shape as transient, never permanent', () => {
    expect(classifyFailure(new Error('mystery'))).toBe('TRANSIENT');
    expect(classifyFailure('a plain string')).toBe('TRANSIENT');
    expect(classifyFailure(null)).toBe('TRANSIENT');
    expect(classifyFailure({ code: 42 })).toBe('TRANSIENT');
  });
});

describe('withRetry', () => {
  it('returns immediately on success', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 }),
    ).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rethrows a permanent error after one attempt', async () => {
    const fn = jest.fn().mockRejectedValue(new PermanentTreasuryError('boom'));
    await expect(
      withRetry(fn, { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 2 }),
    ).rejects.toBeInstanceOf(PermanentTreasuryError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a transient error in place and then succeeds', async () => {
    const lockTimeout = () => Object.assign(new Error('lock'), { code: '55P03' });
    let calls = 0;
    const onRetry = jest.fn();
    const fn = jest.fn(async () => {
      calls += 1;
      if (calls < 3) {
        throw lockTimeout();
      }
      return 'done';
    });

    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 }, onRetry),
    ).resolves.toBe('done');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('throws RetryExhaustedError once maxAttempts is reached', async () => {
    const fn = jest.fn().mockRejectedValue(
      Object.assign(new Error('lock'), { code: '55P03' }),
    );

    await expect(
      withRetry(fn, { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 }),
    ).rejects.toBeInstanceOf(RetryExhaustedError);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
