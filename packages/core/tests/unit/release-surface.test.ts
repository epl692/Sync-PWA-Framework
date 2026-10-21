// T008: Principle V guard. The core must not depend on the test kit or ship the plaintext codec.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('release surface', () => {
  it('declares no runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies ?? {}).toEqual({});
  });

  it('never imports @sync/testkit or the plaintext codec from src', () => {
    for (const file of walk(join(root, 'src')).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/@sync\/testkit/);
      expect(text, file).not.toMatch(/test-plaintext/);
      expect(text, file).not.toMatch(/plaintextCodec/i);
    }
  });
});
