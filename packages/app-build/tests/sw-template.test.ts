// T060: the generated service worker, run in a fake worker scope.
import { describe, expect, it } from 'vitest';
import { generateServiceWorker } from '../src/sw-template';

const SCOPE = 'https://example.test/apps/sample/';
const files = [
  { url: 'index.html', revision: 'r1' },
  { url: 'app.AAA.js', revision: 'r2' },
  { url: 'manifest.webmanifest', revision: 'r3' },
];

class FakeCache {
  entries = new Map<string, string>();
  constructor(readonly fetcher: (url: string) => Promise<string>) {}
  async addAll(reqs: Array<{ url: string } | string>) {
    const urls = reqs.map((r) => (typeof r === 'string' ? r : r.url));
    const bodies = await Promise.all(urls.map((u) => this.fetcher(u)));
    urls.forEach((u, i) => this.entries.set(u, bodies[i]!));
  }
}

function makeScope(opts: { fail?: string[]; existing?: Record<string, string[]> } = {}) {
  const handlers: Record<string, (e: any) => void> = {};
  const stores = new Map<string, FakeCache>();
  const fetcher = async (u: string) => {
    if (opts.fail?.some((f) => u.endsWith(f))) throw new Error('offline');
    return `body:${u}`;
  };
  for (const [name, urls] of Object.entries(opts.existing ?? {})) {
    const c = new FakeCache(fetcher);
    urls.forEach((u) => c.entries.set(u, 'old'));
    stores.set(name, c);
  }
  const fetched: string[] = [];
  const caches = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new FakeCache(fetcher));
      return stores.get(name)!;
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (req: { url: string } | string) => {
      const url = typeof req === 'string' ? req : req.url;
      for (const c of stores.values()) if (c.entries.has(url)) return { cached: c.entries.get(url)! };
      return undefined;
    },
  };
  const state = { skipWaiting: 0, claimed: 0 };
  const self = {
    registration: { scope: SCOPE },
    addEventListener: (type: string, fn: (e: any) => void) => void (handlers[type] = fn),
    skipWaiting: () => void state.skipWaiting++,
    clients: { claim: () => void state.claimed++ },
  };
  const src = generateServiceWorker({ build: 'b1', files });
  new Function('self', 'caches', 'fetch', 'Request', 'URL', src)(self, caches, async (r: { url: string }) => (fetched.push(r.url), { network: r.url }), class { constructor(public url: string, public init?: unknown) {} }, URL);
  const waits: Promise<unknown>[] = [];
  const event = (extra: object) => ({ waitUntil: (p: Promise<unknown>) => void waits.push(p), ...extra });
  return {
    stores,
    state,
    fetched,
    async install() {
      waits.length = 0;
      handlers.install!(event({}));
      await Promise.all(waits);
    },
    async activate() {
      waits.length = 0;
      handlers.activate!(event({}));
      await Promise.all(waits);
    },
    message: (data: unknown) => handlers.message!({ data }),
    fetchEvent(req: { url: string; method?: string; mode?: string }) {
      let response: Promise<unknown> | undefined;
      handlers.fetch!({ request: { method: 'GET', mode: 'cors', ...req }, respondWith: (p: Promise<unknown>) => void (response = p) });
      return response;
    },
  };
}

describe('install', () => {
  it('precaches every listed file under a build-named cache, and install waits for it', async () => {
    const s = makeScope();
    await s.install();
    expect([...s.stores.keys()]).toEqual(['shell-b1']);
    expect([...s.stores.get('shell-b1')!.entries.keys()].sort()).toEqual(files.map((f) => SCOPE + f.url).sort());
  });

  it('a failed install leaves the old cache and fails the install', async () => {
    const s = makeScope({ fail: ['app.AAA.js'], existing: { 'shell-old': [SCOPE + 'index.html'] } });
    await expect(s.install()).rejects.toThrow('offline');
    expect([...s.stores.keys()]).toEqual(['shell-old']);
  });

  it('does not skip waiting on its own', async () => {
    const s = makeScope();
    await s.install();
    expect(s.state.skipWaiting).toBe(0);
  });
});

describe('activate', () => {
  it('deletes other shell-* caches, leaves unrelated caches alone, and never claims clients', async () => {
    const s = makeScope({ existing: { 'shell-old': [], 'sync-modules-v1': [], 'shell-b1': [] } });
    await s.activate();
    expect([...s.stores.keys()].sort()).toEqual(['shell-b1', 'sync-modules-v1']);
    expect(s.state.claimed).toBe(0);
  });
});

describe('fetch', () => {
  it('answers navigations with the cached index.html, even for subpaths and query strings', async () => {
    const s = makeScope();
    await s.install();
    for (const u of [SCOPE, SCOPE + '?x=1', SCOPE + 'some/deep/link']) {
      expect(await s.fetchEvent({ url: u, mode: 'navigate' })).toEqual({ cached: `body:${SCOPE}index.html` });
    }
  });

  it('serves precached files cache-first', async () => {
    const s = makeScope();
    await s.install();
    expect(await s.fetchEvent({ url: SCOPE + 'app.AAA.js' })).toEqual({ cached: `body:${SCOPE}app.AAA.js` });
    expect(s.fetched).toEqual([]);
  });

  it('leaves runtime modules, unlisted files, non-GET and cross-origin requests to the browser', async () => {
    const s = makeScope();
    await s.install();
    expect(s.fetchEvent({ url: SCOPE + 'modules/notes.1.0.0.js' })).toBeUndefined();
    expect(s.fetchEvent({ url: SCOPE + 'modules/manifest.json' })).toBeUndefined();
    expect(s.fetchEvent({ url: SCOPE + 'other.txt' })).toBeUndefined();
    expect(s.fetchEvent({ url: SCOPE + 'app.AAA.js', method: 'POST' })).toBeUndefined();
    expect(s.fetchEvent({ url: 'https://elsewhere.test/app.AAA.js' })).toBeUndefined();
  });

  it('falls back to the network when a precached file is missing from the cache', async () => {
    const s = makeScope();
    expect(await s.fetchEvent({ url: SCOPE + 'app.AAA.js' })).toEqual({ network: SCOPE + 'app.AAA.js' });
  });
});

describe('message', () => {
  it('skipWaiting only on the skipWaiting message', async () => {
    const s = makeScope();
    s.message({ type: 'other' });
    s.message(undefined);
    expect(s.state.skipWaiting).toBe(0);
    s.message({ type: 'skipWaiting' });
    expect(s.state.skipWaiting).toBe(1);
  });
});
