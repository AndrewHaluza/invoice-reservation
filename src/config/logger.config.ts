import type { IncomingMessage } from 'node:http';
import type { Options } from 'pino-http';
import { CORRELATION_HEADER, resolveCorrelationId } from '../shared/correlation';

type CorrelationRequest = IncomingMessage & { correlationId?: string };

export const buildPinoHttpOptions = (level: string): Options => ({
  level,
  // Runs whether it is reached before or after CorrelationMiddleware: it
  // reuses an id already on the request, otherwise resolves one from the
  // header (or a fresh UUID) and stashes it for the middleware to reuse.
  genReqId: (req) => {
    const request = req as CorrelationRequest;
    const correlationId =
      request.correlationId ?? resolveCorrelationId(request.headers[CORRELATION_HEADER]);
    request.correlationId = correlationId;
    return correlationId;
  },
  customProps: (req) => ({
    correlationId: (req as CorrelationRequest).correlationId,
  }),
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]'],
    censor: '[redacted]',
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  // No transport / prettyPrint: production logs are JSON.
});
