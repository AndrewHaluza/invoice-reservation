import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiExtension,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { RequiredScope } from '../../shared/scope';
import { AuditReadService, LedgerEntryBody, Page } from '../application/audit-read.service';
import { ListLedgerQueryDto } from './dto/list-ledger.query';
import { ErrorResponse, LedgerListResponse } from './response';

// The ledger route lives on its own controller so the `capacity:audit` boundary
// is visible in the file layout. It is declared by the contract itself
// (`x-required-scope: capacity:audit`), not derived from FR-017b.
@Controller('v1/programs/:programId')
export class AuditController {
  constructor(private readonly auditReadService: AuditReadService) {}

  @Get('ledger')
  @RequiredScope('capacity:audit')
  @SkipThrottle({ write: true })
  @ApiTags('audit')
  @ApiOperation({
    operationId: 'listLedgerEntries',
    summary: 'Read the append-only ledger behind a program position',
  })
  @ApiExtension('x-required-scope', 'capacity:audit')
  @ApiParam({
    name: 'programId',
    type: String,
    format: 'uuid',
    required: true,
    example: 'b1b2c3d4-0001-4000-8000-000000000011',
  })
  @ApiHeader({
    name: 'x-correlation-id',
    required: false,
    schema: { type: 'string', maxLength: 128 },
  })
  @ApiResponse({ status: 200, description: 'OK', type: LedgerListResponse })
  @ApiResponse({
    status: 401,
    description: 'UNAUTHORIZED. The bearer token is missing, malformed, or expired.',
    type: ErrorResponse,
  })
  @ApiResponse({
    status: 403,
    description:
      'FORBIDDEN. The credential lacks the required scope. This says nothing about whether the program exists.',
    type: ErrorResponse,
  })
  @ApiResponse({
    status: 404,
    description:
      'NOT_FOUND. The program or reservation does not exist, or it belongs to another organisation — the two are deliberately indistinguishable.',
    type: ErrorResponse,
  })
  @ApiResponse({
    status: 429,
    description:
      'Rate limit exceeded for the calling organisation. Reads are limited to 600 requests per minute.',
    type: ErrorResponse,
  })
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
