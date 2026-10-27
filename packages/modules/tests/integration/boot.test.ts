// T032: the three boot phases (resolve, open core, activate) and the production guard (research R-05, R-13).
import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from '@sync/core';
import { assertSecureCore, memoryKeyDb } from '@sync/spaces';
import { createStubIdentityProvider } from '@sync/testkit';
import { startApp } from '../../src/app/start-app';
import type { AppConfig } from '../../src/app/config';
import { mod, simpleType } from '../helpers';

const base = (over: Partial<AppConfig> = {}): AppConfig => ({
  name: 'Test',
  themeColor: '#000000',
  icons: { src192: 'a.png', src512: 'b.png' },
  modules: [],
  ...over,
});
const opts = () => ({ storage: createMemoryStorage(), keyDb: memoryKeyDb(), mode: 'development' as const });

describe('startApp', () => {
  it('resolves, opens the secure core with the selected provider, then activates in order, then calls onReady', async () => {
    const log: string[] = [];
    const prov = mod('prov', {
      provides: { identityProviders: [{ id: 'stub', create: () => (log.push('provider created'), createStubIdentityProvider()) }] },
      activate: () => void log.push('prov activate'),
    });
    const app = mod('app', {
      dependencies: { prov: '^1.0.0' },
      provides: { types: [simpleType('item')] },
      activate: (ctx) => {
        log.push('app activate');
        expect(ctx.moduleId).toBe('app');
      },
    });
    const host = await startApp(
      base({ modules: [app, prov], identityProvider: 'prov.stub', onReady: async (h, spaces) => { log.push(`ready ${h.report().filter((r) => r.status === 'active').length} ${spaces.state}`); } }),
      opts(),
    );
    expect(log).toEqual(['provider created', 'prov activate', 'app activate', 'ready 2 ready']);
    assertSecureCore(host.core);
    expect(host.report().map((r) => r.status)).toEqual(['active', 'active']);
    await host.stop();
  });

  it('uses the first provider when none is selected', async () => {
    const prov = mod('prov', { provides: { identityProviders: [{ id: 'stub', create: () => createStubIdentityProvider() }] } });
    const host = await startApp(base({ modules: [prov] }), opts());
    expect(host.report()[0]!.status).toBe('active');
    await host.stop();
  });

  it('rejects with a clear error when no identity provider is available', async () => {
    await expect(startApp(base({ modules: [mod('plain')] }), opts())).rejects.toThrow(/identity provider/);
  });

  it('rejects when the selected provider cannot be created', async () => {
    const prov = mod('prov', { provides: { identityProviders: [{ id: 'stub', create: () => { throw new Error('no provider today'); } }] } });
    await expect(startApp(base({ modules: [prov], identityProvider: 'prov.stub' }), opts())).rejects.toThrow(/prov\.stub.*no provider today/);
  });

  it('rejects an unknown selected provider id', async () => {
    const prov = mod('prov', { provides: { identityProviders: [{ id: 'stub', create: () => createStubIdentityProvider() }] } });
    await expect(startApp(base({ modules: [prov], identityProvider: 'prov.nope' }), opts())).rejects.toThrow(/prov\.nope/);
  });

  it('keeps going when a non-provider module fails, and reports it', async () => {
    const prov = mod('prov', { provides: { identityProviders: [{ id: 'stub', create: () => createStubIdentityProvider() }] } });
    const bad = mod('bad', { activate: () => { throw new Error('nope'); } });
    const host = await startApp(base({ modules: [prov, bad] }), opts());
    expect(host.report().find((r) => r.id === 'bad')!.status).toBe('failed');
    expect(host.report().find((r) => r.id === 'prov')!.status).toBe('active');
    await host.stop();
  });

  it('survives an onReady that throws', async () => {
    const prov = mod('prov', { provides: { identityProviders: [{ id: 'stub', create: () => createStubIdentityProvider() }] } });
    const host = await startApp(base({ modules: [prov], onReady: () => { throw new Error('ready failed'); } }), opts());
    expect(host.report()[0]!.status).toBe('active');
    await host.stop();
  });

  it('refuses the plaintext test codec in production, and without an injected core elsewhere', async () => {
    const prov = mod('prov', { provides: { identityProviders: [{ id: 'stub', create: () => createStubIdentityProvider() }] } });
    await expect(startApp(base({ modules: [prov], security: 'plaintext-for-tests' }), { ...opts(), mode: 'production' })).rejects.toThrow(/plaintext/);
    await expect(startApp(base({ modules: [prov], security: 'plaintext-for-tests' }), opts())).rejects.toThrow(/options\.core/);
  });
});
