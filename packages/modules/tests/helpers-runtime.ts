/** Fakes for the runtime loader: a Cache Storage, a same-origin file host, and a module "importer". */
import { vi } from 'vitest';
import type { CacheLike, CacheStorageLike } from '../src/loader/cache';
import { ModuleCache } from '../src/loader/cache';
import type { ModuleDefinition } from '../src/types';
import { sha256Integrity } from '../src/loader/load';
import type { ParsedEntry } from '../src/loader/manifest';

export const ORIGIN = 'https://app.test';
export const BASE = `${ORIGIN}/modules/`;
export const MANIFEST_URL = `${BASE}manifest.json`;

export class FakeCache implements CacheLike {
  readonly map = new Map<string, Response>();
  async match(u: string) {
    return this.map.get(u)?.clone();
  }
  async put(u: string, r: Response) {
    this.map.set(u, r);
  }
  async delete(u: string) {
    return this.map.delete(u);
  }
  async keys() {
    return [...this.map.keys()].map((url) => ({ url }));
  }
}

export function fakeModuleCache() {
  const cache = new FakeCache();
  const storage: CacheStorageLike = { open: async () => cache };
  return { cache, moduleCache: new ModuleCache(storage) };
}

/** A module file whose "code" is a marker the fake importer maps back to a definition. */
export const fileBytes = (key: string) => new TextEncoder().encode(`/* ${key} */ export default {};`);

export class FakeHost {
  /** url -> response factory; remove an entry to make it unreachable. */
  files = new Map<string, () => Response | Promise<Response>>();
  calls: Array<{ url: string; init?: RequestInit }> = [];
  manifestDelay?: Promise<void>;
  defs = new Map<string, ModuleDefinition>();

  fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    this.calls.push({ url, init });
    if (url === MANIFEST_URL && this.manifestDelay) {
      await new Promise<void>((resolve, reject) => {
        this.manifestDelay!.then(resolve);
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    const make = this.files.get(url);
    if (!make) throw new TypeError('Failed to fetch');
    const res = await make();
    if (!res.url) Object.defineProperty(res, 'url', { value: url });
    return res;
  });

  /** Serve a module file; returns its entry for the manifest. */
  async serve(id: string, version: string, def: Partial<ModuleDefinition> = {}, opts: { integrity?: string | false; file?: string; bytes?: Uint8Array } = {}) {
    const file = opts.file ?? `${id}.${version}.js`;
    const url = BASE + file;
    const bytes = opts.bytes ?? fileBytes(url + '@' + version);
    this.defs.set(url + '@' + version, { id, version, ...def });
    this.files.set(url, () => new Response(bytes as BodyInit));
    const integrity = opts.integrity === false ? undefined : (opts.integrity ?? (await sha256Integrity(bytes)));
    return { id, version, url: file, ...(integrity ? { integrity } : {}) };
  }

  serveManifest(modules: unknown[], v = 1) {
    this.files.set(MANIFEST_URL, () => new Response(JSON.stringify({ v, modules })));
  }

  /** Stands in for importing a blob: look the definition up from the marker in the bytes. */
  importModule = vi.fn(async (bytes: Uint8Array) => {
    const key = /\/\* (.*) \*\//.exec(new TextDecoder().decode(bytes))?.[1];
    const def = key ? this.defs.get(key) : undefined;
    if (!def) throw new Error('no such module');
    return { default: def };
  });
}

export const entryFor = (id: string, version: string, extra: Partial<ParsedEntry> = {}): ParsedEntry => ({
  id,
  version,
  url: `${id}.${version}.js`,
  resolved: `${BASE}${id}.${version}.js`,
  ...extra,
});
