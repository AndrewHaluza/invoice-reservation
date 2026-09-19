import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { createRedisClient } from '../../src/auth/redis.provider';

describe('createRedisClient', () => {
  let client: Redis | undefined;

  afterEach(() => {
    client?.disconnect();
    client = undefined;
  });

  it('attaches an error listener so a connection error is logged, not thrown', async () => {
    const logger = new Logger('redis-provider-test');
    const errorSpy = jest
      .spyOn(logger, 'error')
      .mockImplementation(() => undefined);

    const redis = createRedisClient('redis://127.0.0.1:1', logger);
    client = redis;

    expect(redis.listenerCount('error')).toBeGreaterThanOrEqual(1);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('redis client did not emit an error in time')),
        10_000,
      );
      redis.once('error', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('redis client error');
  });
});
