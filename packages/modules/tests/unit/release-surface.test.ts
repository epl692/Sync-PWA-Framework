// T006: release guards for the modules runtime and the build tool.
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
  it('@sync/modules has zero runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot('modules'), 'package.json'), 'utf8'));
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it('@sync/app-build depends only on esbuild at runtime', () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot('app-build'), 'package.json'), 'utf8'));
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['esbuild']);
  });

  it('no file under packages/modules/src imports @sync/testkit', () => {
    for (const file of walk(join(pkgRoot('modules'), 'src')).filter((f) => f.endsWith('.ts'))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/@sync\/testkit/);
    }
  });
});
