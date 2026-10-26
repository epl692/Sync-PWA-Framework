// @vitest-environment jsdom
// T074 (US4): how runtime modules join an app that is already running (research R-08, R-13).
import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from '@sync/core';
import { memoryKeyDb } from '@sync/spaces';
import { createStubIdentityProvider, waitFor } from '@sync/testkit';
import { startApp } from '../../src/app/start-app';
import type { AppConfig, StartOptions } from '../../src/app/config';
import type { HostEvent, ModuleDefinition, ModuleHost } from '../../src/types';
import { sha256Integrity } from '../../src/loader/load';
import { BASE, MANIFEST_URL, ORIGIN, FakeHost, fakeModuleCache, fileBytes } from '../helpers-runtime';
import { collectEvents } from '../helpers';

const stub = () => createStubIdentityProvider();
const provModule: ModuleDefinition = { id: 'prov', version: '1.0.0', provides: { identityProviders: [{ id: 'stub', create: stub }] } };

function setup(runtimeConfig: AppConfig['runtime'] = {}) {
  const host = new FakeHost();
  const { cache, moduleCache } = fakeModuleCache();
  const events: HostEvent[] = [];
  const start = async (modules: ModuleDefinition[], over: Partial<AppConfig> = {}): Promise<ModuleHost> => {
    const options: StartOptions = {
      storage: createMemoryStorage(),
      keyDb: memoryKeyDb(),
      mode: 'development',
      serviceWorker: false,
      runtime: { manifestUrl: MANIFEST_URL, origin: ORIGIN, fetch: host.fetch as unknown as typeof fetch, cache: moduleCache, importModule: host.importModule },
    };
    const config: AppConfig = { name: 'T', themeColor: '#000000', icons: { src192: 'a', src512: 'b' }, modules, runtime: runtimeConfig, ...over };
    return startApp(config, options);
  };
  /** Put a manifest and its files in the loader's cache, as an earlier online visit would have. */
  const prime = async (modules: Array<{ id: string; version: string; boot?: boolean }>, defs: Record<string, Partial<ModuleDefinition>> = {}) => {
    const list = [];
    for (const m of modules) {
      const entry = await host.serve(m.id, m.version, defs[m.id] ?? {});
      const bytes = fileBytes(`${BASE}${entry.url}@${m.version}`);
      await moduleCache.putModule(BASE + entry.url, bytes, { id: m.id, version: m.version, integrity: entry.integrity });
      list.push({ ...entry, ...(m.boot ? { boot: true } : {}) });
    }
    await moduleCache.putManifest(MANIFEST_URL, { v: 1, modules: list });
  };
  return { host, cache, moduleCache, events, start, prime };
}
const statusOf = (h: ModuleHost, id: string) => h.report().find((r) => r.id === id)?.status;

describe('bundled modules never wait for the network', () => {
  it('activate and resolve startApp while the manifest request is still pending; runtime modules follow', async () => {
    const t = setup();
    let release!: () => void;
    t.host.manifestDelay = new Promise<void>((r) => (release = r));
    t.host.serveManifest([await t.host.serve('notes', '1.0.0')]);
    const app = await t.start([provModule]);
    expect(statusOf(app, 'prov')).toBe('active');
    expect(statusOf(app, 'notes')).toBeUndefined();
    release();
    await app.ready();
    expect(statusOf(app, 'notes')).toBe('active');
    await app.stop();
  });

  it('falls back to the cached manifest when the network does not answer within the timeout', async () => {
    const t = setup({ manifestTimeoutMs: 30 });
    await t.prime([{ id: 'notes', version: '1.0.0' }]);
    t.host.manifestDelay = new Promise<void>(() => {}); // never answers
    const app = await t.start([provModule]);
    await app.ready();
    expect(statusOf(app, 'notes')).toBe('active');
    expect(t.host.calls.filter((c) => c.url === MANIFEST_URL).length).toBe(1); // asked once, gave up
    await app.stop();
  });

  it('starts with only bundled modules when there is no cache and no network', async () => {
    const t = setup({ manifestTimeoutMs: 30 });
    const app = await t.start([provModule]);
    await app.ready();
    expect(app.report().map((r) => r.id)).toEqual(['prov']);
    await app.stop();
  });
});

describe('runtime modules arriving late', () => {
  it('register when they arrive, and elements already on the page upgrade', async () => {
    const t = setup();
    t.host.serveManifest([
      await t.host.serve('late', '1.0.0', {
        provides: { views: { box: () => class extends HTMLElement { constructor() { super(); this.setAttribute('data-ready', 'yes'); } } } },
      }),
    ]);
    const placed = document.createElement('late-box');
    document.body.append(placed);
    expect(placed.hasAttribute('data-ready')).toBe(false);
    const app = await t.start([provModule]);
    await app.ready();
    expect(customElements.get('late-box')).toBeDefined();
    await waitFor(() => placed.getAttribute('data-ready') === 'yes');
    placed.remove();
    await app.stop();
  });

  it('applies packets that were deferred for the late module’s type', async () => {
    const t = setup();
    t.host.serveManifest([await t.host.serve('typed', '1.0.0', { provides: { types: [{ name: 'thing', versions: [{ version: 1, fields: { a: { type: 'string' } } }] }] } })]);
    const app = await t.start([provModule]);
    await app.ready();
    expect(app.report().find((r) => r.id === 'typed')!.registers.types).toEqual(['typed.thing']);
    await app.stop();
  });

  it('an unreachable file with no cache is unavailable, and modules that depend on it are skipped', async () => {
    const t = setup();
    const notes = await t.host.serve('notes', '1.0.0');
    const extra = await t.host.serve('extra', '1.0.0', { dependencies: { notes: '^1.0.0' } });
    t.host.serveManifest([notes, extra]);
    t.host.files.delete(BASE + notes.url);
    const app = await t.start([provModule]);
    const events = collectEvents(app);
    await app.ready();
    expect(events).toContainEqual({ kind: 'module:unavailable', id: 'notes' });
    expect(statusOf(app, 'notes')).toBe('unavailable');
    expect(statusOf(app, 'extra')).toBe('skipped');
    expect(app.report().find((r) => r.id === 'extra')!.reason).toMatch(/dependency "notes"/);
    expect(statusOf(app, 'prov')).toBe('active');
    await app.stop();
  });

  it('runs a module from its cached copy when the file is unreachable (stale)', async () => {
    const t = setup();
    await t.prime([{ id: 'notes', version: '1.0.0' }]);
    // the manifest now asks for 1.1.0, but its file cannot be reached
    t.host.serveManifest([{ id: 'notes', version: '1.1.0', url: 'notes.1.0.0.js' }]);
    t.host.files.delete(BASE + 'notes.1.0.0.js');
    const app = await t.start([provModule]);
    await app.ready();
    expect(statusOf(app, 'notes')).toBe('stale');
    expect(app.report().find((r) => r.id === 'notes')!.version).toBe('1.0.0');
    await app.stop();
  });
});

describe('refusals', () => {
  it('an entry on another origin is refused and logged; its file is never requested; others load', async () => {
    const t = setup();
    t.host.serveManifest([{ id: 'evil', version: '1.0.0', url: 'https://evil.test/x.js' }, await t.host.serve('fine', '1.0.0')]);
    const app = await t.start([provModule]);
    const events: HostEvent[] = [];
    app.on((e) => events.push(e));
    await app.ready();
    expect(statusOf(app, 'fine')).toBe('active');
    expect(t.host.calls.some((c) => c.url.includes('evil.test'))).toBe(false);
    expect(events).toContainEqual({ kind: 'module:refused', id: 'evil', url: 'https://evil.test/x.js', reason: 'cross-origin' });
    await app.stop();
  });

  it('a module that provides an identity provider but is not boot is refused', async () => {
    const t = setup();
    t.host.serveManifest([await t.host.serve('lateprov', '1.0.0', { provides: { identityProviders: [{ id: 'x', create: stub }] } })]);
    const app = await t.start([provModule]);
    await app.ready();
    expect(statusOf(app, 'lateprov')).toBe('refused');
    expect(app.report().find((r) => r.id === 'lateprov')!.reason).toMatch(/boot: true/);
    await app.stop();
  });

  it('a manifest entry for a bundled id is refused, and the bundled module is untouched', async () => {
    const t = setup();
    t.host.serveManifest([await t.host.serve('prov', '9.9.9')]);
    const app = await t.start([provModule]);
    await app.ready();
    expect(app.report().filter((r) => r.id === 'prov')).toHaveLength(1);
    expect(app.report().find((r) => r.id === 'prov')!.version).toBe('1.0.0');
    await app.stop();
  });
});

describe('boot modules (before the core opens)', () => {
  it('load from the cached manifest, so a runtime module can supply the identity provider', async () => {
    const t = setup();
    await t.prime([{ id: 'bootprov', version: '1.0.0', boot: true }], { bootprov: { provides: { identityProviders: [{ id: 'stub', create: stub }] } } });
    const app = await t.start([]); // no bundled provider at all
    await app.ready();
    expect(statusOf(app, 'bootprov')).toBe('active');
    expect(app.report().find((r) => r.id === 'bootprov')!.source).toBe('runtime');
    await app.stop();
  });

  it('a first launch with no cache waits for the manifest only when waitForBoot is set', async () => {
    const withWait = setup({ waitForBoot: true });
    withWait.host.serveManifest([{ ...(await withWait.host.serve('bootprov', '1.0.0', { provides: { identityProviders: [{ id: 'stub', create: stub }] } })), boot: true }]);
    const app = await withWait.start([]);
    expect(statusOf(app, 'bootprov')).toBe('active');
    await app.stop();

    const without = setup();
    without.host.serveManifest([{ ...(await without.host.serve('bootprov', '1.0.0', { provides: { identityProviders: [{ id: 'stub', create: stub }] } })), boot: true }]);
    await expect(without.start([])).rejects.toThrow(/identity provider/); // nothing to open the core with on a first launch
  });
});
