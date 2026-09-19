import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { RequiredScope } from '../../shared/scope';
import { AuditReadService, LedgerEntryBody, Page } from '../application/audit-read.service';
import { ListLedgerQueryDto } from './dto/list-ledger.query';

// The ledger route lives on its own controller so the `capacity:audit` boundary
// is visible in the file layout. It is declared by the contract itself
// (`x-required-scope: capacity:audit`), not derived from FR-017b.
@Controller('v1/programs/:programId')
export class AuditController {
  constructor(private readonly auditReadService: AuditReadService) {}

  @Get('ledger')
  @RequiredScope('capacity:audit')
  @SkipThrottle({ write: true })
  listLedger(
    @Param('programId', new ParseUUIDPipe({ version: '4' })) programId: string,
    @Query() query: ListLedgerQueryDto,
  ): Promise<Page<LedgerEntryBody>> {
    return this.auditReadService.listLedger(programId, {
      ...(query.from === undefined ? {} : { from: new Date(query.from) }),
      ...(query.to === undefined ? {} : { to: new Date(query.to) }),
      ...(query.cause === undefined ? {} : { cause: query.cause }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
  }
}
