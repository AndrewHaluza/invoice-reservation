import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthenticatedRequest } from './jwt-auth.guard';
import { REQUIRED_SCOPE_KEY } from './required-scope.decorator';

@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string>(
      REQUIRED_SCOPE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (required === undefined) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.auth?.scopes.has(required) !== true) {
      throw new ForbiddenException({
        code: 'INSUFFICIENT_SCOPE',
        message: 'The token lacks a required scope.',
      });
    }

    return true;
  }
}
