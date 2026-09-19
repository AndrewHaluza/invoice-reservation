import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { CORRELATION_HEADER, resolveCorrelationId } from './correlation';

export const correlationStore = new AsyncLocalStorage<{
  correlationId: string;
}>();

export function currentCorrelationId(): string | undefined {
  return correlationStore.getStore()?.correlationId;
}

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    // Respect an id an earlier middleware (pino's genReqId) may already have resolved, so
    // the response header and the log line never disagree even if ordering changes.
    const request = req as Request & { correlationId?: string };
    const correlationId =
      request.correlationId ?? resolveCorrelationId(req.headers[CORRELATION_HEADER]);
    request.correlationId = correlationId;
    res.setHeader(CORRELATION_HEADER, correlationId);
    correlationStore.run({ correlationId }, () => {
      next();
    });
  }
}
