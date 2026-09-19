import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from './public.decorator';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuthContext {
  org: string;
  scopes: Set<string>;
}

export interface AuthenticatedRequest extends Request {
  auth?: AuthContext;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    if (
      typeof authorization !== 'string' ||
      !authorization.startsWith('Bearer ')
    ) {
      throw this.unauthenticated();
    }

    const token = authorization.slice('Bearer '.length).trim();
    if (token.length === 0) {
      throw this.unauthenticated();
    }

    let payload: unknown;
    try {
      payload = await this.jwtService.verifyAsync(token, {
        algorithms: ['HS256'],
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
        clockTolerance:
          this.config.getOrThrow<number>('JWT_CLOCK_SKEW_SECONDS'),
      });
    } catch {
      throw this.unauthenticated();
    }

    if (typeof payload !== 'object' || payload === null) {
      throw this.unauthenticated();
    }

    const claims = payload as Record<string, unknown>;
    const org = claims.org;
    const exp = claims.exp;

    if (typeof exp !== 'number') {
      throw this.unauthenticated();
    }
    if (typeof org !== 'string' || !UUID_PATTERN.test(org)) {
      throw this.unauthenticated();
    }

    const scopes = new Set<string>();
    const scope = claims.scope;
    if (typeof scope === 'string') {
      for (const value of scope.split(' ')) {
        if (value.length > 0) {
          scopes.add(value);
        }
      }
    }

    request.auth = { org, scopes };
    return true;
  }

  private unauthenticated(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'UNAUTHENTICATED',
      message: 'Authentication is required.',
    });
  }
}
