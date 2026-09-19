import { SetMetadata } from '@nestjs/common';

export const REQUIRED_SCOPE_KEY = 'requiredScope';

export const RequiredScope = (scope: string) =>
  SetMetadata(REQUIRED_SCOPE_KEY, scope);
