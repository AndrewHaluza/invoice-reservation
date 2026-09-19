import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthenticatedRequest } from './jwt-auth.guard';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class ProgramScopeGuard implements CanActivate {
  constructor(private readonly dataSource: DataSource) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // Ownership is only resolved for the route parameter named exactly `programId`.
    // Phase 3 MUST name the parameter `programId`; a route using any other name
    // receives no ownership check, which is why this guard returns true here.
    const programId = request.params?.programId;
    if (typeof programId !== 'string' || programId.length === 0) {
      return true;
    }

    // A malformed id would reach Postgres and raise SQLSTATE 22P02, surfacing as a
    // 500 and distinguishing "invalid" from "not yours". Both must answer 404.
    if (!UUID_PATTERN.test(programId)) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Program not found.',
      });
    }

    const rows = await this.dataSource.query<{ organisation_id: string }[]>(
      'SELECT organisation_id FROM program WHERE id = $1',
      [programId],
    );
    const organisationId = rows[0]?.organisation_id;

    // A missing program and a program owned by another organisation are deliberately
    // indistinguishable: both answer NOT_FOUND, so the guard chain never confirms
    // whether a program id exists outside the caller's organisation.
    if (organisationId === undefined || organisationId !== request.auth?.org) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Program not found.',
      });
    }

    return true;
  }
}
