import { DocumentBuilder } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';

export const DOCS_TITLE = 'Program Capacity & Invoice Reservation API';

export const DOCS_DESCRIPTION = [
  'Real-time capacity position for financing programs.',
  'Every endpoint except the health probes requires a bearer token.',
  'A caller reaches only the programs owned by the organisation its token identifies;',
  'anything else resolves to 404, never 403, so the API never reveals whether an',
  'out-of-scope program exists. A 403 means the credential lacks the required scope,',
  'which says nothing about any program.',
  'Reads are limited to 600 requests per minute per calling organisation and writes to 120;',
  'exceeding either returns 429 with the standard error body. The budgets are per',
  'organisation, so one tenant cannot deny service to another.',
  'All monetary amounts are integer strings in minor units with an explicit ISO-4217',
  'currency. They are never JSON numbers.',
].join(' ');

export function buildDocumentConfig(port: number, version: string): Omit<OpenAPIObject, 'paths'> {
  return new DocumentBuilder()
    .setOpenAPIVersion('3.1.0')
    .setTitle(DOCS_TITLE)
    .setDescription(DOCS_DESCRIPTION)
    .setVersion(version)
    .addServer(`http://localhost:${port}`, 'Local development')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'bearerAuth',
    )
    .addSecurityRequirements('bearerAuth')
    .addTag('capacity', 'Reserve, release, and cancel capacity, and read a program position')
    .addTag('audit', 'Read reservations and the append-only ledger behind a position')
    .addTag('health', 'Liveness and readiness probes. No credential required.')
    .build();
}
