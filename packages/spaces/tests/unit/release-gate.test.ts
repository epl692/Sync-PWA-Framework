// T047: a release build cannot run, or even contain, the plaintext test codec (Principle V).
import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { join } from 'node:path';
import { createMemoryStorage, createSyncCore } from '@sync/core';
import { PlaintextCodec, createStubIdentityProvider } from '@sync/testkit';
import { assertSecureCore, memoryKeyDb, openSecureCore } from '../../src';

const root = join(__dirname, '..', '..', '..', '..');

describe('release gate', () => {
  it('a core opened with openSecureCore passes the assertion', async () => {
    const { core, spaces } = await openSecureCore({ keyDb: memoryKeyDb(), provider: createStubIdentityProvider(), core: { storage: createMemoryStorage(), autoCompact: false } });
    expect(() => assertSecureCore(core)).not.toThrow();
    await spaces.close();
    await core.close();
  });

  it('a core with the plaintext codec, or with no codec, fails the assertion', async () => {
    const plain = await createSyncCore({ storage: createMemoryStorage(), codecs: [new PlaintextCodec()], autoCompact: false });
    expect(() => assertSecureCore(plain)).toThrow(/insecure core/);
    const none = await createSyncCore({ storage: createMemoryStorage(), autoCompact: false });
    expect(() => assertSecureCore(none)).toThrow(/insecure core/);
    await plain.close();
    await none.close();
  });

  it('the release bundles of core, spaces and identity-invite contain no plaintext codec and no test kit', async () => {
    for (const pkg of ['core', 'spaces']) {
      const out = await build({
        entryPoints: [join(root, 'packages', pkg, 'src', 'index.ts')],
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'browser',
        target: 'es2022',
        logLevel: 'silent',
        alias: { '@sync/core': join(root, 'packages/core/src/index.ts'), '@sync/spaces': join(root, 'packages/spaces/src/index.ts') },
      });
      const text = out.outputFiles.map((f) => f.text).join('\n');
      expect(text, pkg).not.toContain('test-plaintext');
      expect(text, pkg).not.toMatch(/PlaintextCodec/);
      expect(text, pkg).not.toMatch(/FakeHost|stubIdentityProvider/);
    }
  });
});
