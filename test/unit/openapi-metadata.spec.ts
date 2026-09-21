import {
  buildDocumentConfig,
  DOCS_TITLE,
} from '../../src/docs/openapi-metadata';

describe('openapi document metadata', () => {
  const document = buildDocumentConfig(4010, '0.1.0');

  it('declares OpenAPI 3.1.0', () => {
    expect(document.openapi).toBe('3.1.0');
  });

  it('uses the documented title', () => {
    expect(document.info.title).toBe(DOCS_TITLE);
  });

  it('uses the supplied version', () => {
    expect(document.info.version).toBe('0.1.0');
  });

  it('explains the 404, never 403 behaviour', () => {
    expect(document.info.description).toContain('404, never 403');
  });

  it('advertises the supplied local server', () => {
    expect(document.servers?.[0]?.url).toBe('http://localhost:4010');
  });

  it('defines the bearer security scheme', () => {
    expect(document.components?.securitySchemes?.bearerAuth).toEqual({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
  });

  it('applies bearer auth to the whole document', () => {
    expect(document.security).toEqual([{ bearerAuth: [] }]);
  });

  it('orders the tags capacity, audit, health', () => {
    expect(document.tags?.map((tag) => tag.name)).toEqual(['capacity', 'audit', 'health']);
  });
});
