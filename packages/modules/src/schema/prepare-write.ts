import type { JSONValue } from '@sync/core';
import type { RegisteredType } from './types';

/**
 * Fills defaults (creates only), picks the schema version to write at (always the latest), and mirrors the change
 * into older versions' field names with each version's `down`, so peers still on those versions see it.
 * Receivers never fill defaults, so every peer sees exactly what the author wrote.
 */
export function prepareWrite(
  reg: RegisteredType,
  op: 'create' | 'update',
  fields: Record<string, JSONValue>,
): { schemaVersion: number; fields: Record<string, JSONValue> } {
  const versions = reg.def.versions;
  const latest = versions[reg.latest - 1]!;
  const out: Record<string, JSONValue> = { ...fields };
  if (op === 'create') {
    for (const [name, def] of Object.entries(latest.fields)) {
      if (name in out) continue;
      if ('default' in def && def.default !== undefined) out[name] = def.default as JSONValue;
    }
  }

  // oldest version still written for: one back when the latest can mirror, none otherwise
  const lowest = reg.def.compatWrite ?? (latest.down ? reg.latest - 1 : reg.latest);
  let changed: Record<string, JSONValue> = out;
  for (let v = reg.latest; v > lowest; v--) {
    const down = versions[v - 1]!.down;
    if (!down) break; // no way further down
    let mirror;
    try {
      mirror = down(changed);
    } catch (e) {
      throw new Error(`down() of ${reg.type} version ${v} threw: ${e instanceof Error ? e.message : String(e)}`);
    }
    const lower: Record<string, JSONValue> = {};
    for (const [name, value] of Object.entries(mirror)) {
      if (value === undefined || typeof value === 'symbol') continue; // "nothing to say"
      lower[name] = value as JSONValue;
      if (!(name in out)) out[name] = value as JSONValue; // what the caller wrote wins over a mirror
    }
    changed = lower;
  }
  return { schemaVersion: reg.latest, fields: out };
}
