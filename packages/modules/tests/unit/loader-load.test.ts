// T073: fetch, verify, cache and run one runtime module (FR-010, FR-011, research R-08).
import { describe, expect, it } from 'vitest';
import { loadRuntimeModule, sha256Integrity, type LoaderDeps } from '../../src/loader/load';
import type { HostEvent } from '../../src/types';
import { BASE, ORIGIN, FakeHost, entryFor, fakeModuleCache, fileBytes } from '../helpers-runtime';

function setup() {
  const host = new FakeHost();
  const { cache, moduleCache } = fakeModuleCache();
  const events: HostEvent[] = [];
  const deps: LoaderDeps = { fetch: host.fetch as unknown as typeof fetch, cache: moduleCache, origin: ORIGIN, emit: (e) => void events.push(e), importModule: host.importModule };
  return { host, cache, moduleCache, events, deps };
}
const entryWith = async (host: FakeHost, id = 'notes', version = '1.0.0', def = {}) => {
  const m = await host.serve(id, version, def);
  return entryFor(id, version, { integrity: m.integrity });
};

describe('loading from the network', () => {
  it('fetches without following redirects or using the HTTP cache, verifies, caches, and runs the verified bytes', async () => {
    const { host, deps, moduleCache } = setup();
    const entry = await entryWith(host);
    const r = await loadRuntimeModule(deps, entry);
    expect(r).toMatchObject({ ok: true, from: 'network', stale: false });
    if (r.ok) expect(r.def).toMatchObject({ id: 'notes', version: '1.0.0' });
    expect(host.calls).toEqual([{ url: entry.resolved, init: expect.objectContaining({ redirect: 'error', cache: 'no-store' }) }]);
    const cached = await moduleCache.getModule(entry.resolved);
    expect(cached).toMatchObject({ id: 'notes', version: '1.0.0', integrity: entry.integrity });
    expect(host.importModule).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(host.importModule.mock.calls[0]![0] as Uint8Array)).toBe(new TextDecoder().decode(cached!.bytes));
  });

  it('refuses a response that came from another origin', async () => {
    const { host, deps, events } = setup();
    const entry = await entryWith(host);
    host.files.set(entry.resolved, () => Object.defineProperty(new Response(fileBytes('x')), 'url', { value: 'https://evil.test/notes.js' }));
    const r = await loadRuntimeModule(deps, entry);
    expect(r.ok).toBe(false);
    expect(events).toContainEqual({ kind: 'module:refused', id: 'notes', url: entry.resolved, reason: 'cross-origin' });
    expect(host.importModule).not.toHaveBeenCalled();
  });

  it('treats an HTTP error like an unreachable file', async () => {
    const { host, deps, events } = setup();
    const entry = await entryWith(host);
    host.files.set(entry.resolved, () => new Response('nope', { status: 500 }));
    expect(await loadRuntimeModule(deps, entry)).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(events).toEqual([{ kind: 'module:unavailable', id: 'notes' }]);
  });
});

describe('integrity', () => {
  it('refuses a file that does not match its hash, and nothing runs', async () => {
    const { host, deps, events, moduleCache } = setup();
    const entry = { ...(await entryWith(host)), integrity: await sha256Integrity(new Uint8Array([1, 2, 3])) };
    const r = await loadRuntimeModule(deps, entry);
    expect(r).toMatchObject({ ok: false, reason: 'integrity' });
    expect(events).toEqual([{ kind: 'module:refused', id: 'notes', url: entry.resolved, reason: 'integrity' }]);
    expect(host.importModule).not.toHaveBeenCalled();
    expect(await moduleCache.getModule(entry.resolved)).toBeUndefined();
  });

  it('on a mismatch keeps using the previously cached copy (stale)', async () => {
    const { host, deps, events, moduleCache } = setup();
    const v1 = await entryWith(host, 'notes', '1.0.0');
    await loadRuntimeModule(deps, v1);
    const v2 = { ...(await entryWith(host, 'notes', '1.1.0')), resolved: v1.resolved, integrity: await sha256Integrity(new Uint8Array([9])) };
    host.files.set(v1.resolved, () => new Response(fileBytes(BASE + 'notes.1.1.0.js@1.1.0')));
    host.defs.set(BASE + 'notes.1.0.0.js@1.0.0', { id: 'notes', version: '1.0.0' });
    events.length = 0;
    const r = await loadRuntimeModule(deps, v2);
    expect(r).toMatchObject({ ok: true, from: 'cache', stale: true });
    if (r.ok) expect(r.def.version).toBe('1.0.0');
    expect(events.map((e) => e.kind)).toEqual(['module:refused', 'module:stale']);
    expect((await moduleCache.getModule(v1.resolved))!.version).toBe('1.0.0');
  });

  it('loads without integrity when the manifest gives none', async () => {
    const { host, deps } = setup();
    const m = await host.serve('notes', '1.0.0', {}, { integrity: false });
    expect(await loadRuntimeModule(deps, entryFor('notes', '1.0.0'))).toMatchObject({ ok: true });
    expect(m.integrity).toBeUndefined();
  });
});

describe('offline and failures', () => {
  it('uses a cached copy of any version when the network is unavailable, and says so', async () => {
    const { host, deps, events } = setup();
    const v1 = await entryWith(host, 'notes', '1.0.0');
    await loadRuntimeModule(deps, v1);
    events.length = 0;
    host.files.delete(v1.resolved);
    const asked = { ...entryFor('notes', '1.1.0'), resolved: v1.resolved };
    const r = await loadRuntimeModule(deps, asked);
    expect(r).toMatchObject({ ok: true, from: 'cache', stale: true });
    expect(events).toEqual([{ kind: 'module:stale', id: 'notes', cachedVersion: '1.0.0' }]);
  });

  it('finds the cached copy by module id when the new version has a new file name', async () => {
    const { host, deps, events } = setup();
    const v1 = await entryWith(host, 'notes', '1.0.0');
    await loadRuntimeModule(deps, v1);
    events.length = 0;
    const v2 = await entryWith(host, 'notes', '1.1.0');
    host.files.delete(v2.resolved); // unreachable, and a different URL from the cached 1.0.0
    const r = await loadRuntimeModule(deps, v2);
    expect(r).toMatchObject({ ok: true, from: 'cache', stale: true });
    if (r.ok) expect(r.def.version).toBe('1.0.0');
    expect(events).toEqual([{ kind: 'module:stale', id: 'notes', cachedVersion: '1.0.0' }]);
  });

  it('with no cache and no network the module is unavailable', async () => {
    const { host, deps, events } = setup();
    const entry = await entryWith(host);
    host.files.delete(entry.resolved);
    expect(await loadRuntimeModule(deps, entry)).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(events).toEqual([{ kind: 'module:unavailable', id: 'notes' }]);
  });

  it('does not fetch when the cache already holds this version with a matching hash', async () => {
    const { host, deps } = setup();
    const entry = await entryWith(host);
    await loadRuntimeModule(deps, entry);
    host.fetch.mockClear();
    const r = await loadRuntimeModule(deps, entry);
    expect(r).toMatchObject({ ok: true, from: 'cache', stale: false });
    expect(host.fetch).not.toHaveBeenCalled();
  });

  it('refetches when the cached bytes no longer match the hash', async () => {
    const { host, deps, cache, moduleCache } = setup();
    const entry = await entryWith(host);
    await loadRuntimeModule(deps, entry);
    await moduleCache.putModule(entry.resolved, fileBytes('tampered'), { id: 'notes', version: '1.0.0' });
    expect(cache.map.size).toBe(1);
    host.fetch.mockClear();
    const r = await loadRuntimeModule(deps, entry);
    expect(r).toMatchObject({ ok: true, from: 'network' });
    expect(host.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('what a module file may contain', () => {
  const bad = ["import x from './x.js';\nexport default {};", "import './side.js';", 'import{a}from"b";export default {};', "export * from 'y';", "export { a } from 'y';", "const m = await import('z');\nexport default m;"];
  it.each(bad)('refuses a file with an import: %s', async (code) => {
    const { host, deps, events } = setup();
    const entry = await entryWith(host);
    host.files.set(entry.resolved, () => new Response(code));
    entry.integrity = undefined;
    const r = await loadRuntimeModule(deps, entry);
    expect(r).toMatchObject({ ok: false, reason: 'malformed', detail: expect.stringContaining('no import statements') });
    expect(events).toContainEqual({ kind: 'module:refused', id: 'notes', url: entry.resolved, reason: 'malformed' });
  });

  it('does not mistake ordinary code for an import', async () => {
    const { host, deps } = setup();
    const entry = await entryWith(host);
    entry.integrity = undefined;
    host.files.set(entry.resolved, () => new Response(`/* ${entry.resolved}@1.0.0 */\nimportant = 1;\nconst important = 1;\nconst meta = import.meta;\nconst a = { import: 1 };\nexport default {};`));
    expect(await loadRuntimeModule(deps, entry)).toMatchObject({ ok: true });
  });

  it('refuses a file whose exported id or version differs from the manifest', async () => {
    const { host, deps, events } = setup();
    const entry = await entryWith(host, 'notes', '1.0.0', { id: 'other' });
    const r = await loadRuntimeModule(deps, entry);
    expect(r).toMatchObject({ ok: false, reason: 'malformed', detail: expect.stringContaining('other@1.0.0') });
    expect(events).toContainEqual({ kind: 'module:refused', id: 'notes', url: entry.resolved, reason: 'malformed' });
    const e2 = await entryWith(host, 'notes2', '1.0.0', { version: '9.9.9' });
    expect(await loadRuntimeModule(deps, e2)).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('refuses a file that fails to load', async () => {
    const { host, deps } = setup();
    const entry = await entryWith(host);
    host.importModule.mockRejectedValueOnce(new Error('SyntaxError: nope'));
    expect(await loadRuntimeModule(deps, entry)).toMatchObject({ ok: false, reason: 'malformed', detail: expect.stringContaining('SyntaxError') });
  });
});
