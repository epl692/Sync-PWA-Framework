// T003: release guards for @sync/blobs, the relay and the modules/blobs dependency direction.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const pkgRoot = (name: string) => join(__dirname, '..', '..', '..', name);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const sources = (name: string) => walk(join(pkgRoot(name), 'src')).filter((f) => f.endsWith('.ts'));

describe('release surface', () => {
  it('@sync/blobs has zero runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot('blobs'), 'package.json'), 'utf8'));
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it('no file under packages/blobs/src imports @sync/testkit', () => {
    for (const f of sources('blobs')) expect(readFileSync(f, 'utf8'), f).not.toMatch(/@sync\/testkit/);
  });

  it('the relay holds no keys: nothing under packages/relay-server/src imports @sync/spaces', () => {
    for (const f of sources('relay-server')) expect(readFileSync(f, 'utf8'), f).not.toMatch(/@sync\/spaces/);
  });

  it('@sync/blobs/ref is pure: it re-exports format/ref only', () => {
    const f = join(pkgRoot('blobs'), 'src', 'ref.ts');
    if (!existsSync(f)) return;
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) expect(m[1], 'ref.ts import').toBe('./format/ref');
    const ref = join(pkgRoot('blobs'), 'src', 'format', 'ref.ts');
    if (existsSync(ref)) for (const m of readFileSync(ref, 'utf8').matchAll(/from\s+'([^']+)'/g)) expect(m[1], 'format/ref.ts import').toMatch(/^\.\/constants$/);
  });

  it('@sync/modules imports @sync/blobs only through @sync/blobs/ref (and type-only roots)', () => {
    for (const f of sources('modules')) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        const m = line.match(/from\s+'(@sync\/blobs[^']*)'/);
        if (!m) continue;
        const ok = m[1] === '@sync/blobs/ref' || /^\s*import type\b/.test(line) || /^\s*export type\b/.test(line);
        expect(ok, `${f}: ${line.trim()}`).toBe(true);
      }
    }
  });
});
