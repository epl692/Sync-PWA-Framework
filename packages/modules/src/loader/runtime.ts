/** The runtime loader: manifest handling plus loading entries. One per app (research R-08). */

import type { HostEvent, ModuleDefinition } from '../types';
import { ModuleCache } from './cache';
import { loadRuntimeModule, type LoaderDeps, type LoadOutcome } from './load';
import { parseManifest, type ParsedEntry, type ParsedManifest } from './manifest';

export interface RuntimeOptions {
  manifestUrl: string;
  origin: string;
  bundledIds: ReadonlySet<string>;
  emit(e: HostEvent): void;
  fetch?: typeof fetch;
  cache?: ModuleCache;
  importModule?: LoaderDeps['importModule'];
  integrityOf?: LoaderDeps['integrityOf'];
  /** Default 2500. */
  manifestTimeoutMs?: number;
}

export interface LoadedModule {
  entry: ParsedEntry;
  outcome: LoadOutcome;
}

export class RuntimeLoader {
  readonly cache: ModuleCache;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly o: RuntimeOptions) {
    this.cache = o.cache ?? new ModuleCache();
    this.fetchFn = o.fetch ?? ((...a) => globalThis.fetch(...a));
    this.timeoutMs = o.manifestTimeoutMs ?? 2500;
  }

  private parse(json: unknown): ParsedManifest {
    const parsed = parseManifest(json, this.o.manifestUrl, this.o.origin, this.o.bundledIds);
    for (const r of parsed.refused) {
      this.o.emit({ kind: 'module:refused', id: r.id, url: r.url, reason: r.reason });
    }
    return parsed;
  }

  /** The manifest from the loader's cache: instant, works offline. */
  async cachedManifest(): Promise<ParsedManifest | undefined> {
    const json = await this.cache.getManifest(this.o.manifestUrl);
    return json === undefined ? undefined : this.parse(json);
  }

  /** The manifest from the network, within the timeout. Caches it, and prunes files it no longer lists. */
  async fetchManifest(timeoutMs = this.timeoutMs): Promise<ParsedManifest | undefined> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await this.fetchFn(this.o.manifestUrl, { redirect: 'error', cache: 'no-store', signal: ctl.signal });
      if (!res.ok) return undefined; // 404: this app has no runtime modules (or the host is down); keep what we have
      if (res.url && new URL(res.url).origin !== this.o.origin) return undefined;
      const json = await res.json();
      const parsed = this.parse(json);
      if (!parsed.unsupported) {
        await this.cache.putManifest(this.o.manifestUrl, json);
      }
      return parsed;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Tidy the cache once the manifest's modules have been loaded (see ModuleCache.prune). */
  prune(manifest: ParsedManifest): Promise<void> {
    return this.cache.prune(this.o.manifestUrl, manifest.entries.map((e) => ({ id: e.id, resolved: e.resolved })));
  }

  private deps(): LoaderDeps {
    return { fetch: this.fetchFn, cache: this.cache, origin: this.o.origin, emit: this.o.emit, importModule: this.o.importModule, integrityOf: this.o.integrityOf };
  }

  /** Load entries in parallel. Never throws. */
  loadAll(entries: readonly ParsedEntry[]): Promise<LoadedModule[]> {
    return Promise.all(entries.map(async (entry) => ({ entry, outcome: await loadRuntimeModule(this.deps(), entry) })));
  }

  /** Fetch, verify and cache a file without running it (updates while the app is open). */
  async prefetch(entry: ParsedEntry): Promise<boolean> {
    const cached = await this.cache.getModule(entry.resolved);
    if (cached && cached.version === entry.version) return true;
    const outcome = await loadRuntimeModule({ ...this.deps(), importModule: async () => ({ default: { id: entry.id, version: entry.version } as ModuleDefinition }), emit: (e) => e.kind === 'module:refused' && this.o.emit(e) }, entry);
    return outcome.ok && outcome.from === 'network';
  }
}
