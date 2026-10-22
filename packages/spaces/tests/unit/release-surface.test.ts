// T005: release guards for the security packages.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const pkgRoot = (name: string) => join(__dirname, '..', '..', '..', name);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('release surface', () => {
  it('@sync/spaces has zero runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot('spaces'), 'package.json'), 'utf8'));
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it('@sync/identity-invite depends only on qrcode-generator at runtime', () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot('identity-invite'), 'package.json'), 'utf8'));
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['qrcode-generator']);
  });

  it('neither package imports @sync/testkit or the plaintext codec from src', () => {
    for (const name of ['spaces', 'identity-invite']) {
      for (const file of walk(join(pkgRoot(name), 'src')).filter((f) => f.endsWith('.ts'))) {
        const text = readFileSync(file, 'utf8');
        expect(text, file).not.toMatch(/@sync\/testkit/);
        expect(text, file).not.toMatch(/test-plaintext/);
      }
    }
  });
});
