import type { JSONValue } from '@sync/core';
import type { RegisteredType } from './types';

/**
 * Fills defaults (creates only) and picks the schema version to write at: always the latest.
 * Receivers never fill defaults, so every peer sees exactly what the author wrote.
 */
export function prepareWrite(
  reg: RegisteredType,
  op: 'create' | 'update',
  fields: Record<string, JSONValue>,
): { schemaVersion: number; fields: Record<string, JSONValue> } {
  const out: Record<string, JSONValue> = { ...fields };
  if (op === 'create') {
    for (const [name, def] of Object.entries(reg.def.versions[reg.latest - 1]!.fields)) {
      if (name in out) continue;
      if ('default' in def && def.default !== undefined) out[name] = def.default as JSONValue;
    }
  }
  return { schemaVersion: reg.latest, fields: out };
}
