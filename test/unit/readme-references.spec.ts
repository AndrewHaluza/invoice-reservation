import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');

function capture(match: RegExpExecArray | RegExpMatchArray): string {
  const value = match[1];
  if (value === undefined) {
    throw new Error(`expected a captured group in ${match[0]}`);
  }
  return value;
}

function pathExists(relative: string): boolean {
  const absolute = join(ROOT, relative);
  if (relative.endsWith('/')) {
    return existsSync(absolute) && statSync(absolute).isDirectory();
  }
  return existsSync(absolute);
}

describe('README references', () => {
  it('names only npm scripts that exist', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    for (const match of README.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) {
      const name = capture(match);
      expect({ token: name, known: Object.prototype.hasOwnProperty.call(scripts, name) }).toEqual({
        token: name,
        known: true,
      });
    }
  });

  it('references only shell scripts that exist', () => {
    for (const match of README.matchAll(/(?:\.\/)?scripts\/([a-z0-9-]+\.(?:sh|ts))/g)) {
      const path = `scripts/${capture(match)}`;
      expect({ token: path, exists: pathExists(path) }).toEqual({ token: path, exists: true });
    }
  });

  it('references only concrete source and doc paths that exist', () => {
    for (const match of README.matchAll(
      /`([a-zA-Z0-9_./-]+\.(?:ts|md|mjs|json|yaml|yml|example))`/g,
    )) {
      const path = capture(match);
      if (!path.includes('/') || path.startsWith('http')) continue;
      if (path.startsWith('dist/') || path.startsWith('node_modules/')) continue;
      expect({ token: path, exists: pathExists(path) }).toEqual({ token: path, exists: true });
    }
  });

  it('names only environment variables declared in env.schema.ts', () => {
    const schema = readFileSync(join(ROOT, 'src', 'config', 'env.schema.ts'), 'utf8');
    const keys = new Set(
      [...schema.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:/gm)].map((match) => capture(match)),
    );
    // Capitals that are not environment variables: formats, protocols, HTTP verbs,
    // a seed constant, a shell variable, and a path component. Kept here rather
    // than weakened out of the regex above.
    const nonVariables = new Set([
      'API',
      'HTTP',
      'JSON',
      'YAML',
      'URL',
      'UUID',
      'SQL',
      'TODO',
      'README',
      'MIT',
      'ISO',
      'JWT',
      'SASL',
      'TLS',
      'CI',
      'GET',
      'POST',
      'PATCH',
      'PUT',
      'DELETE',
      'NOT',
      'AND',
      'OR',
      'NORTHWIND_USD_PROGRAM_ID',
      'TOKEN',
      'ASSUMPTIONS',
    ]);
    for (const match of README.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) {
      const token = capture(match);
      if (nonVariables.has(token)) continue;
      expect({ token, known: keys.has(token) }).toEqual({ token, known: true });
    }
  });

  it('links only relative targets that exist', () => {
    for (const match of README.matchAll(/\]\((?!https?:)([^)#]+)/g)) {
      const target = capture(match).trim();
      expect({ token: target, exists: pathExists(target) }).toEqual({ token: target, exists: true });
    }
  });

  it('contains no credential, token, or credentialed connection string', () => {
    for (const token of [
      'capacity_local_dev',
      'local_dev_jwt_secret_change_me_0123456789',
      'eyJ',
    ]) {
      expect({ token, present: README.includes(token) }).toEqual({ token, present: false });
    }
    expect({ token: 'postgres:// with @', present: /postgres:\/\/[^\s)]*@/.test(README) }).toEqual({
      token: 'postgres:// with @',
      present: false,
    });
  });
});
