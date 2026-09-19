import {
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';
import type { Response } from 'express';
import { currentCorrelationId } from '../shared/correlation';
import { AuthenticatedRequest } from './jwt-auth.guard';

@Injectable()
export class OrgThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(
    req: Record<string, unknown>,
  ): Promise<string> {
    const request = req as unknown as AuthenticatedRequest;
    return request.auth?.org ?? (request.ip as string);
  }

  protected override async throwThrottlingException(
    context: ExecutionContext,
    throttlerLimitDetail: ThrottlerLimitDetail,
  ): Promise<void> {
    const retryAfter = Math.ceil(throttlerLimitDetail.timeToBlockExpire);
    const response = context.switchToHttp().getResponse<Response>();
    response.header('Retry-After', String(retryAfter));

    throw new HttpException(
      {
        code: 'RATE_LIMITED',
        message: 'Request budget exceeded for this organisation.',
        correlationId: currentCorrelationId(),
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
