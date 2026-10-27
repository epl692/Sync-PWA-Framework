/** Fetch, verify, cache and import one runtime module (contracts/runtime-manifest.md, research R-08). */

import type { HostEvent, ModuleDefinition } from '../types';
import type { ModuleCache } from './cache';
import type { ParsedEntry } from './manifest';

export interface LoaderDeps {
  fetch: typeof fetch;
  cache: ModuleCache;
  /** This page's origin. */
  origin: string;
  emit(e: HostEvent): void;
  /** Execute verified bytes as a module and return its namespace. Default: import from a blob URL. */
  importModule?: (bytes: Uint8Array) => Promise<unknown>;
  /** SHA-256 as `sha256-<base64>`. Default: Web Crypto. */
  integrityOf?: (bytes: Uint8Array) => Promise<string>;
}

export type LoadOutcome =
  | { ok: true; def: ModuleDefinition; from: 'cache' | 'network'; stale: boolean }
  | { ok: false; reason: 'unavailable' | 'integrity' | 'malformed'; detail: string };

export async function sha256Integrity(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  let bin = '';
  for (const b of digest) bin += String.fromCharCode(b);
  return `sha256-${btoa(bin)}`;
}

/** Run the exact verified bytes as a module, from a blob URL, so redirects and later changes cannot alter what runs. */
export async function importFromBytes(bytes: Uint8Array): Promise<unknown> {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'text/javascript' }));
  try {
    return await import(/* @vite-ignore */ url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// A module file is a single bundle with no imports. This only gives a clearer error than the browser's
// ("failed to resolve module specifier"); the real guarantee is that a blob module cannot resolve imports.
const HAS_IMPORT = /(^|[;}\n])\s*(import\b\s*[\w{*"'`]|export\b\s*(\*|\{[^}]*\})\s*from\b)|\bimport\s*\(/;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function loadRuntimeModule(deps: LoaderDeps, entry: ParsedEntry): Promise<LoadOutcome> {
  const hash = deps.integrityOf ?? sha256Integrity;
  const run = deps.importModule ?? importFromBytes;
  const url = entry.resolved;
  const cached = (await deps.cache.getModule(url)) ?? (await deps.cache.findById(entry.id));

  /** Bytes the loader may run, and whether they came from the network. */
  let bytes: Uint8Array | undefined;
  let from: 'cache' | 'network' = 'cache';
  let stale = false;
  let sawIntegrityFailure = false;

  const cachedValid = async () => {
    if (!cached || cached.version !== entry.version) return false;
    if (entry.integrity && (await hash(cached.bytes)) !== entry.integrity) return false;
    return true;
  };

  if (await cachedValid()) {
    bytes = cached!.bytes;
  } else {
    try {
      const res = await deps.fetch(url, { redirect: 'error', cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (res.url && new URL(res.url).origin !== deps.origin) {
        deps.emit({ kind: 'module:refused', id: entry.id, url, reason: 'cross-origin' });
        return { ok: false, reason: 'malformed', detail: `response came from ${new URL(res.url).origin}` };
      }
      const fetched = new Uint8Array(await res.arrayBuffer());
      const actual = await hash(fetched);
      if (entry.integrity && actual !== entry.integrity) {
        sawIntegrityFailure = true;
        deps.emit({ kind: 'module:refused', id: entry.id, url, reason: 'integrity' });
      } else {
        bytes = fetched;
        from = 'network';
        await deps.cache.putModule(url, fetched, { id: entry.id, version: entry.version, integrity: actual });
      }
    } catch {
      /* unreachable: fall through to the cached copy */
    }
    if (!bytes && cached) {
      bytes = cached.bytes;
      stale = true;
    }
  }

  if (!bytes) {
    if (!sawIntegrityFailure) deps.emit({ kind: 'module:unavailable', id: entry.id });
    return { ok: false, reason: sawIntegrityFailure ? 'integrity' : 'unavailable', detail: sawIntegrityFailure ? 'the file does not match its integrity hash and nothing is cached' : 'not reachable and not cached' };
  }
  if (stale) deps.emit({ kind: 'module:stale', id: entry.id, cachedVersion: cached!.version });

  const text = new TextDecoder().decode(bytes);
  if (HAS_IMPORT.test(text)) {
    deps.emit({ kind: 'module:refused', id: entry.id, url, reason: 'malformed' });
    return { ok: false, reason: 'malformed', detail: 'a runtime module must be a single file with no import statements' };
  }

  let def: ModuleDefinition | undefined;
  try {
    def = ((await run(bytes)) as { default?: ModuleDefinition }).default;
  } catch (e) {
    deps.emit({ kind: 'module:refused', id: entry.id, url, reason: 'malformed' });
    return { ok: false, reason: 'malformed', detail: `could not load: ${message(e)}` };
  }
  const expectedVersion = stale ? cached!.version : entry.version;
  if (!def || typeof def !== 'object' || def.id !== entry.id || def.version !== expectedVersion) {
    deps.emit({ kind: 'module:refused', id: entry.id, url, reason: 'malformed' });
    return { ok: false, reason: 'malformed', detail: `the file exports ${def ? `${def.id}@${def.version}` : 'no default export'}, the manifest says ${entry.id}@${expectedVersion}` };
  }
  return { ok: true, def, from, stale };
}
