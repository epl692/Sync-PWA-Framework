// @vitest-environment jsdom
// AppConfig.approveJoin / approveLink reach openSecureCore, so apps can show the SAS and let a person decide.
import { describe, expect, it, vi } from 'vitest';
import { createMemoryStorage } from '@sync/core';
import { memoryKeyDb } from '@sync/spaces';
import { createStubIdentityProvider } from '@sync/testkit';
import { startApp } from '../../src/app/start-app';
import type { AppConfig } from '../../src/app/config';
import type { ModuleDefinition } from '../../src/types';

const seen: Array<Record<string, unknown>> = [];
vi.mock('@sync/spaces', async (orig) => {
  const real = await orig<typeof import('@sync/spaces')>();
  return {
    ...real,
    openSecureCore: (opts: Parameters<typeof real.openSecureCore>[0]) => {
      seen.push(opts as unknown as Record<string, unknown>);
      return real.openSecureCore(opts);
    },
  };
});

const prov: ModuleDefinition = { id: 'testprov', version: '1.0.0', provides: { identityProviders: [{ id: 'stub', create: () => createStubIdentityProvider() }] } };

describe('approval hooks', () => {
  it('are handed to openSecureCore unchanged', async () => {
    const approveJoin = vi.fn(() => true);
    const approveLink = vi.fn(() => true);
    const config: AppConfig = {
      name: 'T',
      themeColor: '#000000',
      icons: { src192: 'a', src512: 'b' },
      modules: [prov],
      runtime: { manifest: false },
      approveJoin,
      approveLink,
    };
    const host = await startApp(config, { storage: createMemoryStorage(), keyDb: memoryKeyDb(), mode: 'development', serviceWorker: false });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.approveJoin).toBe(approveJoin);
    expect(seen[0]!.approveLink).toBe(approveLink);
    await host.stop?.();
  });

  it('are absent (so the safe default of refusing applies) when the app gives none', async () => {
    seen.length = 0;
    const config: AppConfig = { name: 'T', themeColor: '#000000', icons: { src192: 'a', src512: 'b' }, modules: [prov], runtime: { manifest: false } };
    const host = await startApp(config, { storage: createMemoryStorage(), keyDb: memoryKeyDb(), mode: 'development', serviceWorker: false });
    expect(seen[0]!.approveJoin).toBeUndefined();
    expect(seen[0]!.approveLink).toBeUndefined();
    await host.stop?.();
  });
});
