/** The runtime manifest and the rules for refusing entries (contracts/runtime-manifest.md). */

import { MODULE_ID_RE } from '../definition/rules';
import { parseVersion } from '../definition/semver';

export interface ManifestEntry {
  id: string;
  version: string;
  /** As written in the manifest. */
  url: string;
  /** `sha256-<base64>`. */
  integrity?: string;
  boot?: boolean;
}

export type RefusalReason = 'cross-origin' | 'bad-scheme' | 'id-clash' | 'malformed';

export interface ParsedEntry extends ManifestEntry {
  /** Absolute and checked to be same-origin http(s). */
  resolved: string;
}

export interface ParsedManifest {
  entries: ParsedEntry[];
  refused: Array<{ id?: string; url?: string; reason: RefusalReason; detail: string }>;
  /** A manifest version this build does not understand: nothing new is loaded. */
  unsupported?: boolean;
}

const INTEGRITY_RE = /^sha256-[A-Za-z0-9+/]+={0,2}$/;

export function parseManifest(json: unknown, manifestUrl: string, origin: string, bundledIds: ReadonlySet<string>): ParsedManifest {
  const out: ParsedManifest = { entries: [], refused: [] };
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    out.refused.push({ reason: 'malformed', detail: 'manifest is not an object' });
    return out;
  }
  const m = json as { v?: unknown; modules?: unknown };
  if (m.v !== 1) {
    if (typeof m.v === 'number' && m.v > 1) out.unsupported = true;
    else out.refused.push({ reason: 'malformed', detail: `manifest version ${JSON.stringify(m.v)} is not 1` });
    return out;
  }
  if (!Array.isArray(m.modules)) {
    out.refused.push({ reason: 'malformed', detail: 'manifest has no modules list' });
    return out;
  }

  const seen = new Set<string>();
  for (const raw of m.modules as unknown[]) {
    const e = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id : undefined;
    const url = typeof e.url === 'string' ? e.url : undefined;
    const refuse = (reason: RefusalReason, detail: string) => void out.refused.push({ id, url, reason, detail });

    if (!id || !MODULE_ID_RE.test(id)) {
      refuse('malformed', `id ${JSON.stringify(e.id)} is not a valid module id`);
      continue;
    }
    try {
      parseVersion(e.version as string);
    } catch {
      refuse('malformed', `version ${JSON.stringify(e.version)} is not semver`);
      continue;
    }
    if (!url) {
      refuse('malformed', 'entry has no url');
      continue;
    }
    if (e.integrity !== undefined && (typeof e.integrity !== 'string' || !INTEGRITY_RE.test(e.integrity))) {
      refuse('malformed', 'integrity must look like sha256-<base64>');
      continue;
    }
    if (e.boot !== undefined && typeof e.boot !== 'boolean') {
      refuse('malformed', 'boot must be true or false');
      continue;
    }

    let resolved: URL;
    try {
      resolved = new URL(url, manifestUrl);
    } catch {
      refuse('malformed', `url ${JSON.stringify(url)} cannot be resolved`);
      continue;
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      refuse('bad-scheme', `scheme ${resolved.protocol} is not allowed`);
      continue;
    }
    if (resolved.origin !== origin) {
      refuse('cross-origin', `${resolved.origin} is not this app's origin (${origin})`);
      continue;
    }
    if (bundledIds.has(id)) {
      refuse('id-clash', `module "${id}" is bundled; a manifest cannot replace shipped code`);
      continue;
    }
    if (seen.has(id)) {
      refuse('id-clash', `module "${id}" is listed twice`);
      continue;
    }
    seen.add(id);
    out.entries.push({ id, version: e.version as string, url, ...(e.integrity ? { integrity: e.integrity as string } : {}), ...(e.boot ? { boot: true } : {}), resolved: resolved.href });
  }
  return out;
}
