/** The loader's own cache of the manifest and verified module files (Cache Storage `sync-modules-v1`). */

import { compareVersions } from '../definition/semver';

export interface CacheLike {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
  delete(request: string): Promise<boolean>;
  keys(): Promise<ReadonlyArray<{ url: string }>>;
}
export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
}

export const CACHE_NAME = 'sync-modules-v1';

export interface CachedModule {
  bytes: Uint8Array;
  id: string;
  version: string;
  integrity?: string;
}

export class ModuleCache {
  private opened?: Promise<CacheLike>;

  constructor(
    private readonly storage: CacheStorageLike | undefined = (globalThis as { caches?: CacheStorageLike }).caches,
    private readonly name = CACHE_NAME,
  ) {}

  private cache(): Promise<CacheLike> | undefined {
    if (!this.storage) return undefined;
    return (this.opened ??= this.storage.open(this.name));
  }

  /** Whether any cache is available at all (Cache Storage can be missing or blocked). */
  get available(): boolean {
    return !!this.storage;
  }

  async getManifest(url: string): Promise<unknown | undefined> {
    try {
      const res = await (await this.cache())?.match(url);
      return res ? await res.json() : undefined;
    } catch {
      return undefined;
    }
  }

  async putManifest(url: string, json: unknown): Promise<void> {
    try {
      await (await this.cache())?.put(url, new Response(JSON.stringify(json), { headers: { 'content-type': 'application/json' } }));
    } catch {
      /* a cache that cannot be written just means no offline copy */
    }
  }

  async getModule(url: string): Promise<CachedModule | undefined> {
    try {
      const res = await (await this.cache())?.match(url);
      if (!res) return undefined;
      return {
        bytes: new Uint8Array(await res.arrayBuffer()),
        id: res.headers.get('x-sync-id') ?? '',
        version: res.headers.get('x-sync-version') ?? '',
        integrity: res.headers.get('x-sync-integrity') ?? undefined,
      };
    } catch {
      return undefined;
    }
  }

  async putModule(url: string, bytes: Uint8Array, meta: { id: string; version: string; integrity?: string }): Promise<void> {
    try {
      const headers: Record<string, string> = { 'content-type': 'text/javascript', 'x-sync-id': meta.id, 'x-sync-version': meta.version };
      if (meta.integrity) headers['x-sync-integrity'] = meta.integrity;
      await (await this.cache())?.put(url, new Response(bytes as BodyInit, { headers }));
    } catch {
      /* see putManifest */
    }
  }

  /** The newest cached copy of a module, whatever URL it was fetched from (the manifest may have moved to a new file name). */
  async findById(id: string): Promise<(CachedModule & { url: string }) | undefined> {
    try {
      const cache = await this.cache();
      if (!cache) return undefined;
      let best: (CachedModule & { url: string }) | undefined;
      for (const req of await cache.keys()) {
        const m = await this.getModule(req.url);
        if (m && m.id === id && (!best || compareVersions(m.version, best.version) > 0)) best = { ...m, url: req.url };
      }
      return best;
    } catch {
      return undefined;
    }
  }

  /**
   * Housekeeping after a manifest has been loaded and its modules have been loaded or have failed:
   * drop modules the manifest no longer lists, and older copies of a listed module once the listed one is cached.
   * An older copy is kept while the listed version is not cached, as the fallback for an unreachable file.
   */
  async prune(manifestUrl: string, listed: ReadonlyArray<{ id: string; resolved: string }>): Promise<void> {
    try {
      const cache = await this.cache();
      if (!cache) return;
      const byId = new Map(listed.map((e) => [e.id, e.resolved]));
      const urls = (await cache.keys()).map((k) => k.url);
      const present = new Set(urls);
      for (const url of urls) {
        if (url === manifestUrl) continue;
        const m = await this.getModule(url);
        const wanted = m ? byId.get(m.id) : undefined;
        if (!m || wanted === undefined) await cache.delete(url); // not listed any more
        else if (url !== wanted && present.has(wanted)) await cache.delete(url); // superseded
      }
    } catch {
      /* best effort */
    }
  }
}
