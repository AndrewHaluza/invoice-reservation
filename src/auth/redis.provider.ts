import { Logger } from '@nestjs/common';
import Redis from 'ioredis';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

export function createRedisClient(url: string, logger: Logger): Redis {
  const client = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false });
  // Without this listener an emitted 'error' is an unhandled error event and
  // terminates the process: a Redis blip would take down the API rather than
  // degrading rate limiting.
  client.on('error', (error: Error) => {
    logger.error(`redis client error: ${error.message}`);
  });
  return client;
}
