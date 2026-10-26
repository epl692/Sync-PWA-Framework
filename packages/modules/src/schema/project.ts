/** Read-time projection of a stored object to the current schema version (research R-07, R-09). */

import type { JSONValue, SyncableObject } from '@sync/core';
import type { ProjectedObject } from '../types';
import { clockedFields, maxClockOf, type ClockedEntry } from './clocked';
import { validateFieldValue } from './fields';
import { isDerived } from './migrate';
import type { RegisteredType } from './types';

type View = Map<string, ClockedEntry>;

/** The stored fields as (value, clock) pairs. An unset field keeps its clock but has no value. */
function storedView(obj: SyncableObject): View {
  const view: View = new Map();
  for (const [name, value] of Object.entries(obj.fields)) view.set(name, { value, clock: obj.clocks?.[name] ?? '' });
  for (const [name, clock] of Object.entries(obj.clocks ?? {})) if (!view.has(name)) view.set(name, { value: undefined, clock });
  return view;
}

const restrict = (view: View, names: Iterable<string>): View => {
  const out: View = new Map();
  for (const n of names) {
    const e = view.get(n);
    if (e) out.set(n, e);
  }
  return out;
};

/**
 * What the app sees. The object's fields are viewed as version 1 (names version 1 declares), then each version's
 * `up` migration derives the next one, up to the latest. Peers on the same versions see the same result, because the
 * input is the converged stored state. Nothing is ever written back.
 *
 * Names no version declares (written by a newer schema) stay in storage and are not shown. A stored value that
 * fails the current schema is left out and listed in `violations`.
 */
export function project(reg: RegisteredType, obj: SyncableObject): ProjectedObject {
  const versions = reg.def.versions;
  const stored = storedView(obj);
  let cur = restrict(stored, Object.keys(versions[0]!.fields));

  for (let v = 1; v < reg.latest; v++) {
    const next = versions[v]!; // version v + 1
    const names = Object.keys(next.fields);
    const own = restrict(stored, names);

    // unchanged names: the later write of the earlier version's view and the natively written one (a tie keeps the native one)
    const merged: View = new Map();
    for (const n of names) {
      const p = cur.get(n);
      const o = own.get(n);
      const pick = p && (!o || p.clock > o.clock) ? p : o;
      if (pick) merged.set(n, pick);
    }

    // what the migration decides, on top
    const result = next.up ? next.up(clockedFields(cur), clockedFields(own)) : {};
    const fallbackClock = maxClockOf(cur);
    for (const [name, r] of Object.entries(result)) {
      if (!(name in next.fields)) continue; // a migration decides this version's fields only
      if (isDerived(r)) merged.set(name, { value: r.value, clock: r.clock });
      else merged.set(name, { value: r, clock: fallbackClock });
    }
    cur = merged;
  }

  const latest = versions[reg.latest - 1]!;
  const fields: Record<string, JSONValue> = {};
  const violations: Array<{ field: string; detail: string }> = [];
  for (const [name, def] of Object.entries(latest.fields)) {
    const value = cur.get(name)?.value;
    if (value === undefined) continue;
    const bad = validateFieldValue(def, value);
    if (bad) violations.push({ field: name, detail: bad });
    else fields[name] = value;
  }
  const out: ProjectedObject = { id: obj.id, type: obj.type, space: obj.space, fields, seenVersion: obj.schemaVersion };
  if (violations.length) out.violations = violations;
  return out;
}
