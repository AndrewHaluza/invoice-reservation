import type { INestApplication } from '@nestjs/common';
import {
  mountApiDocs,
  DOCS_PATH,
  DOCS_JSON_PATH,
  DOCS_YAML_PATH,
} from '../../src/docs/docs.bootstrap';

describe('mountApiDocs', () => {
  it('returns false and registers nothing when disabled', () => {
    const calls: string[] = [];
    const fakeApp = {
      getHttpAdapter: () => calls.push('getHttpAdapter'),
      use: () => calls.push('use'),
    } as unknown as INestApplication; // A faithful INestApplication has dozens of members; the disabled path must not touch this minimal recorder at all.

    const mounted = mountApiDocs(fakeApp, { enabled: false, port: 4010, version: '0.1.0' });

    expect(mounted).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('documentation paths', () => {
  it('exposes the UI path', () => {
    expect(DOCS_PATH).toBe('docs');
  });

  it('exposes the JSON document path', () => {
    expect(DOCS_JSON_PATH).toBe('docs/openapi.json');
  });

  it('exposes the YAML document path', () => {
    expect(DOCS_YAML_PATH).toBe('docs/openapi.yaml');
  });
});
