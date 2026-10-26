// T076: buildModule produces a self-contained file (contracts/runtime-manifest.md, "Module file format").
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BuildError } from '../src/build-app';
import { buildModule } from '../src/build-module';
import { cleanup, tmpDir, write } from './helpers';

afterAll(cleanup);

function setup(files: Record<string, string>) {
  const dir = tmpDir('mod');
  for (const [name, content] of Object.entries(files)) write(dir, name, content);
  return { dir, entry: join(dir, 'index.ts'), out: join(dir, 'out', 'notes.js') };
}
const hasImport = (code: string) => /(^|[;}\n])\s*(import\b\s*[\w{*"'`]|export\b\s*(\*|\{[^}]*\})\s*from\b)|\bimport\s*\(/.test(code);
const MODULE = `export default { id: 'notes', version: '1.2.0', provides: { types: [{ name: 'note', versions: [{ version: 1, fields: { text: { type: 'string' } } }] }] } };`;

describe('buildModule', () => {
  it('writes one file with no imports, and returns the id, version and sha256 integrity of that exact file', async () => {
    const t = setup({ 'index.ts': MODULE });
    const r = await buildModule({ entry: t.entry, outFile: t.out });
    const bytes = readFileSync(t.out);
    expect(hasImport(bytes.toString('utf8'))).toBe(false);
    expect(r).toMatchObject({ id: 'notes', version: '1.2.0' });
    expect(r.integrity).toBe(`sha256-${createHash('sha256').update(bytes).digest('base64')}`);
  });

  it('inlines relative imports, and erases type-only imports', async () => {
    const t = setup({
      'helper.ts': `export const label = (s: string) => s.toUpperCase();`,
      'index.ts': `import type { ModuleDefinition } from '@sync/modules';\nimport { label } from './helper';\nexport default { id: 'notes', version: '1.0.0', provides: { views: { list: () => class extends HTMLElement { connectedCallback() { this.textContent = label('hi'); } } } } } satisfies ModuleDefinition;`,
    });
    await buildModule({ entry: t.entry, outFile: t.out });
    const code = readFileSync(t.out, 'utf8');
    expect(hasImport(code)).toBe(false);
    expect(code).toContain('toUpperCase');
    expect(code).not.toContain('@sync/modules');
  });

  it('returns the runtime manifest entry for a url', async () => {
    const t = setup({ 'index.ts': MODULE });
    const r = await buildModule({ entry: t.entry, outFile: t.out, manifestEntry: { url: 'notes.1.2.0.js' } });
    expect(r.manifestEntry).toEqual({ id: 'notes', version: '1.2.0', url: 'notes.1.2.0.js', integrity: r.integrity });
  });

  it('fails when an import survives bundling (a dynamic import of a variable)', async () => {
    const t = setup({ 'index.ts': `const name = 'x';\nexport default { id: 'notes', version: '1.0.0', activate: async () => { await import(name); } };` });
    const e = await buildModule({ entry: t.entry, outFile: t.out }).then(() => undefined, (x) => x);
    expect(e).toBeInstanceOf(BuildError);
    expect((e as BuildError).problems.join()).toMatch(/dynamic import/);
  });

  it('fails when esbuild cannot resolve an import, naming it', async () => {
    const t = setup({ 'index.ts': `import { nope } from 'does-not-exist-anywhere';\nexport default { id: 'notes', version: '1.0.0', nope };` });
    const e = await buildModule({ entry: t.entry, outFile: t.out }).then(() => undefined, (x) => x);
    expect(e).toBeInstanceOf(BuildError);
    expect((e as BuildError).problems.join()).toMatch(/does-not-exist-anywhere/);
  });

  it('fails when the default export is not a module definition', async () => {
    const t = setup({ 'index.ts': `export default { name: 'notes' };` });
    await expect(buildModule({ entry: t.entry, outFile: t.out })).rejects.toThrow(/id and a version/);
    const u = setup({ 'index.ts': `export const x = 1;` });
    await expect(buildModule({ entry: u.entry, outFile: u.out })).rejects.toThrow(/id and a version/);
  });
});
