// T075: noticing newer runtime modules while the app is open (research R-08).
import { describe, expect, it } from 'vitest';
import { RuntimeLoader } from '../../src/loader/runtime';
import { UpdateChecker } from '../../src/loader/update';
import type { HostEvent } from '../../src/types';
import { BASE, MANIFEST_URL, ORIGIN, FakeHost, fakeModuleCache, fileBytes } from '../helpers-runtime';

function setup(active: Record<string, string> = {}) {
  const host = new FakeHost();
  const { cache, moduleCache } = fakeModuleCache();
  const events: HostEvent[] = [];
  const runtime = new RuntimeLoader({ manifestUrl: MANIFEST_URL, origin: ORIGIN, bundledIds: new Set(), emit: (e) => void events.push(e), fetch: host.fetch as unknown as typeof fetch, cache: moduleCache, importModule: host.importModule });
  let now = 1_000_000;
  const checker = new UpdateChecker({ runtime, activeVersions: () => new Map(Object.entries(active)), emit: (e) => void events.push(e), now: () => now });
  return { host, cache, moduleCache, events, runtime, checker, advance: (ms: number) => void (now += ms), active };
}

describe('UpdateChecker', () => {
  it('fetches, verifies and caches a newer version, and announces it, without running it', async () => {
    const t = setup({ notes: '1.0.0' });
    const v2 = await t.host.serve('notes', '1.1.0');
    t.host.serveManifest([v2]);
    await t.checker.check(true);
    expect(t.events).toEqual([{ kind: 'module:update-available', id: 'notes', version: '1.1.0' }]);
    expect((await t.moduleCache.getModule(BASE + v2.url))!.version).toBe('1.1.0');
    expect(t.host.importModule).not.toHaveBeenCalled();
  });

  it('announces a module that is new to the manifest', async () => {
    const t = setup({});
    t.host.serveManifest([await t.host.serve('fresh', '1.0.0')]);
    await t.checker.check(true);
    expect(t.events).toEqual([{ kind: 'module:update-available', id: 'fresh', version: '1.0.0' }]);
  });

  it('says nothing when the running version is the listed one', async () => {
    const t = setup({ notes: '1.0.0' });
    t.host.serveManifest([await t.host.serve('notes', '1.0.0')]);
    await t.checker.check(true);
    expect(t.events).toEqual([]);
  });

  it('announces each version once', async () => {
    const t = setup({ notes: '1.0.0' });
    t.host.serveManifest([await t.host.serve('notes', '1.1.0')]);
    await t.checker.check(true);
    await t.checker.check(true);
    expect(t.events).toHaveLength(1);
  });

  it('does not announce a file whose integrity check fails', async () => {
    const t = setup({ notes: '1.0.0' });
    const v2 = await t.host.serve('notes', '1.1.0');
    t.host.serveManifest([{ ...v2, integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }]);
    await t.checker.check(true);
    expect(t.events.map((e) => e.kind)).toEqual(['module:refused']);
  });

  it('automatic checks run at most once per 5 minutes; a forced check always runs', async () => {
    const t = setup({ notes: '1.0.0' });
    t.host.serveManifest([]);
    await t.checker.check();
    await t.checker.check();
    expect(t.host.calls.filter((c) => c.url === MANIFEST_URL)).toHaveLength(1);
    t.advance(4 * 60_000);
    await t.checker.check();
    expect(t.host.calls.filter((c) => c.url === MANIFEST_URL)).toHaveLength(1);
    t.advance(60_001);
    await t.checker.check();
    expect(t.host.calls.filter((c) => c.url === MANIFEST_URL)).toHaveLength(2);
    await t.checker.check(true);
    expect(t.host.calls.filter((c) => c.url === MANIFEST_URL)).toHaveLength(3);
  });

  it('shares one request between overlapping checks', async () => {
    const t = setup({});
    t.host.serveManifest([]);
    await Promise.all([t.checker.check(true), t.checker.check(true)]);
    expect(t.host.calls.filter((c) => c.url === MANIFEST_URL)).toHaveLength(1);
  });

  it('checks when the device comes online and when the page becomes visible', async () => {
    const t = setup({});
    t.host.serveManifest([]);
    const handlers: Record<string, () => void> = {};
    const doc = { visibilityState: 'hidden', addEventListener: (type: string, cb: () => void) => void (handlers['doc:' + type] = cb) };
    t.checker.attach({ addEventListener: (type, cb) => void (handlers['win:' + type] = cb) }, doc);
    handlers['doc:visibilitychange']!(); // hidden: nothing
    await new Promise((r) => setTimeout(r, 0));
    expect(t.host.calls).toHaveLength(0);
    doc.visibilityState = 'visible';
    handlers['doc:visibilitychange']!();
    await new Promise((r) => setTimeout(r, 0));
    expect(t.host.calls.filter((c) => c.url === MANIFEST_URL)).toHaveLength(1);
    t.advance(6 * 60_000);
    handlers['win:online']!();
    await new Promise((r) => setTimeout(r, 0));
    expect(t.host.calls.filter((c) => c.url === MANIFEST_URL)).toHaveLength(2);
  });

  it('does nothing when the manifest cannot be fetched', async () => {
    const t = setup({ notes: '1.0.0' });
    await t.checker.check(true);
    expect(t.events).toEqual([]);
  });
});

describe('cache housekeeping', () => {
  const loadAndPrune = async (t: ReturnType<typeof setup>) => {
    const manifest = (await t.runtime.fetchManifest())!;
    await t.runtime.loadAll(manifest.entries);
    await t.runtime.prune(manifest);
  };

  it('drops files of modules the manifest no longer lists, and keeps listed ones', async () => {
    const t = setup();
    const keep = await t.host.serve('keep', '1.0.0');
    const drop = await t.host.serve('drop', '1.0.0');
    t.host.serveManifest([keep, drop]);
    await loadAndPrune(t);
    expect([...t.cache.map.keys()].sort()).toEqual([BASE + drop.url, BASE + keep.url, MANIFEST_URL].sort());
    t.host.serveManifest([keep]);
    await loadAndPrune(t);
    expect([...t.cache.map.keys()].sort()).toEqual([BASE + keep.url, MANIFEST_URL].sort());
  });

  it('removes an older version once the listed one is cached, but keeps it as the fallback until then', async () => {
    const t = setup();
    const v1 = await t.host.serve('notes', '1.0.0');
    t.host.serveManifest([v1]);
    await loadAndPrune(t);
    const v2 = await t.host.serve('notes', '1.1.0');
    t.host.serveManifest([v2]);
    t.host.files.delete(BASE + v2.url); // the new file is unreachable
    await loadAndPrune(t);
    expect(t.cache.map.has(BASE + v1.url)).toBe(true); // fallback kept
    t.host.files.set(BASE + v2.url, () => new Response(fileBytes(BASE + v2.url + '@1.1.0')));
    await loadAndPrune(t);
    expect(t.cache.map.has(BASE + v2.url)).toBe(true);
    expect(t.cache.map.has(BASE + v1.url)).toBe(false); // superseded
  });

  it('keeps everything when the manifest could not be fetched', async () => {
    const t = setup();
    const m = await t.host.serve('keep', '1.0.0');
    t.host.serveManifest([m]);
    await loadAndPrune(t);
    t.host.files.delete(MANIFEST_URL);
    expect(await t.runtime.fetchManifest()).toBeUndefined();
    expect(t.cache.map.has(BASE + m.url)).toBe(true);
  });

  it('keeps everything for a manifest version it does not understand', async () => {
    const t = setup();
    const m = await t.host.serve('keep', '1.0.0');
    t.host.serveManifest([m]);
    await loadAndPrune(t);
    t.host.serveManifest([], 2);
    await t.runtime.fetchManifest();
    expect(t.cache.map.has(BASE + m.url)).toBe(true);
    expect(await t.moduleCache.getManifest(MANIFEST_URL)).toMatchObject({ v: 1 });
  });
});
