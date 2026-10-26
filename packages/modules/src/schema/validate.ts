/** Pure validation of one packet body against its own schema version (schema-rules.md §1). */

import type { JSONValue } from '@sync/core';
import { checkBaseType, isRequired, isUnsetMarker, validateFieldValue } from './fields';
import type { FieldDef, RegisteredType } from './types';

export type ValidationOutcome = { ok: true } | { ok: false; field?: string; detail: string };

export interface BodyToValidate {
  op: 'create' | 'update' | 'delete';
  schemaVersion: number;
  fields: Record<string, JSONValue>;
}

const reject = (detail: string, field?: string): ValidationOutcome => ({ ok: false, detail, ...(field !== undefined ? { field } : {}) });

/**
 * The verdict depends only on `body` and the registered schema: no clock, no stored state, no other objects.
 * That is what lets every peer reach the same verdict (research R-04).
 */
export function validateBody(reg: RegisteredType, body: BodyToValidate): ValidationOutcome {
  if (body.op === 'delete') return { ok: true };

  const k = body.schemaVersion;
  if (!Number.isInteger(k) || k < 1) return reject('bad-version');

  const versions = reg.def.versions;
  const lenient = k > reg.latest;
  const top = Math.min(k, reg.latest);
  const own = versions[top - 1]!;

  /** The newest version at or below `top` that declares the name. */
  const defFor = (name: string): FieldDef | undefined => {
    for (let v = top; v >= 1; v--) {
      const f = versions[v - 1]!.fields[name];
      if (f) return f;
    }
    return undefined;
  };

  for (const [name, value] of Object.entries(body.fields)) {
    const def = defFor(name);
    if (!def) {
      if (lenient) continue; // a field from a newer schema: keep it, we cannot judge it
      return reject('unknown-field', name);
    }
    if (isUnsetMarker(value)) {
      const ownDef = own.fields[name];
      if (!lenient && ownDef && isRequired(ownDef)) return reject(`field "${name}" is required and cannot be unset`, name);
      continue;
    }
    const bad = lenient ? checkBaseType(def, value) : validateFieldValue(def, value);
    if (bad) return reject(bad, name);
  }

  if (body.op === 'create' && !lenient) {
    for (const [name, def] of Object.entries(own.fields)) {
      if (!isRequired(def)) continue;
      const v = body.fields[name];
      if (v === undefined || isUnsetMarker(v)) return reject(`field "${name}" is required`, name);
    }
    if (own.objectCheck) {
      try {
        const msg = own.objectCheck(body.fields);
        if (msg) return reject(msg);
      } catch (e) {
        return reject(`check-threw: ${(e as Error).message}`);
      }
    }
  }
  return { ok: true };
}
