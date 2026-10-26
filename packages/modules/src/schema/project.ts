/** Read-time projection of a stored object to the current schema version (research R-07, R-09). */

import type { SyncableObject } from '@sync/core';
import type { ProjectedObject } from '../types';
import { validateFieldValue } from './fields';
import type { RegisteredType } from './types';

/**
 * Single-version projection: only fields declared by the latest version are exposed; stored values that
 * fail the schema are omitted and listed in `violations`. Migration across versions arrives with US6.
 */
export function project(reg: RegisteredType, obj: SyncableObject): ProjectedObject {
  const latest = reg.def.versions[reg.latest - 1]!;
  const fields: Record<string, import('@sync/core').JSONValue> = {};
  const violations: Array<{ field: string; detail: string }> = [];
  for (const [name, def] of Object.entries(latest.fields)) {
    const value = obj.fields[name];
    if (value === undefined) continue;
    const bad = validateFieldValue(def, value);
    if (bad) violations.push({ field: name, detail: bad });
    else fields[name] = value;
  }
  const out: ProjectedObject = { id: obj.id, type: obj.type, space: obj.space, fields, seenVersion: obj.schemaVersion };
  if (violations.length) out.violations = violations;
  return out;
}
