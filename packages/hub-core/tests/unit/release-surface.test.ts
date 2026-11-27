// Spec 005 T005: the Hub holds no content keys and has no third-party runtime dependencies.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const sources = walk(join(root, 'src')).filter((f) => f.endsWith('.ts'));

describe('release surface (hub-core)', () => {
  it('has only workspace runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    for (const name of Object.keys(pkg.dependencies ?? {})) expect(name, name).toMatch(/^@sync\//);
  });

  it('no source file imports @sync/spaces (the Hub holds no content keys, FR-011)', () => {
    for (const f of sources) expect(readFileSync(f, 'utf8'), f).not.toMatch(/@sync\/spaces/);
  });

  it('no source file imports @sync/testkit', () => {
    for (const f of sources) expect(readFileSync(f, 'utf8'), f).not.toMatch(/@sync\/testkit/);
  });

  it('imports the link codec only through the pure ./link subpath', () => {
    for (const f of sources) {
      for (const m of readFileSync(f, 'utf8').matchAll(/from\s+'(@sync\/transport-bluetooth[^']*)'/g)) {
        expect(m[1], f).toBe('@sync/transport-bluetooth/link');
      }
    }
  });
});
