// Spec 005 T005: release guards for @sync/transport-bluetooth.
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

describe('release surface (transport-bluetooth)', () => {
  it('@sync/core is the only runtime dependency', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['@sync/core']);
  });

  it('no source file imports @sync/testkit', () => {
    for (const f of sources) expect(readFileSync(f, 'utf8'), f).not.toMatch(/@sync\/testkit/);
  });

  it('the link codec imports no @sync/spaces and never touches navigator', () => {
    for (const f of sources.filter((s) => s.includes(`${join('src', 'link')}`))) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/@sync\/spaces/);
      expect(src, f).not.toMatch(/\bnavigator\b/);
    }
  });

  it('only webBluetooth.ts touches navigator.bluetooth', () => {
    for (const f of sources) {
      if (f.endsWith('webBluetooth.ts')) continue;
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/navigator\.bluetooth/);
    }
  });
});
