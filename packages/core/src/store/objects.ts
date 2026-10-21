/** Stored object state and the merge rules (specs/001-sync-core/data-model.md). */

import { maxClock } from '../clock/hlc';
import type { DataPacketEnvelope, JSONValue, ObjectId, PacketBody, SpaceId, SyncableObject } from '../types';

export interface FieldEntry {
  value: JSONValue;
  clock: string;
}

export interface StoredObject {
  id: ObjectId;
  type: string;
  space: SpaceId;
  schemaVersion: number;
  fields: Record<string, FieldEntry>;
  deleted: boolean;
  deleteClock: string | null;
  createdClock: string;
  updatedClock: string;
}

export function isUnset(v: JSONValue): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && (v as Record<string, JSONValue>).$unset === true;
}

/** Merge one packet into an object. Pure: commutative, associative and idempotent per packet. */
export function mergeInto(
  existing: StoredObject | undefined,
  body: PacketBody,
  env: Pick<DataPacketEnvelope, 'clock' | 'space'>,
): { obj: StoredObject; changed: boolean } {
  const base: StoredObject = existing
    ? structuredClone(existing)
    : {
        id: body.obj,
        type: body.type,
        space: env.space,
        schemaVersion: body.schemaVersion,
        fields: {},
        deleted: false,
        deleteClock: null,
        createdClock: env.clock,
        updatedClock: env.clock,
      };
  let changed = !existing;

  if (env.clock < base.createdClock) {
    base.createdClock = env.clock;
    base.type = body.type;
    base.space = env.space;
    changed = true;
  }
  if (body.schemaVersion > base.schemaVersion) {
    base.schemaVersion = body.schemaVersion;
    changed = true;
  }

  if (body.op === 'delete') {
    const dc = base.deleteClock === null ? env.clock : maxClock(base.deleteClock, env.clock);
    if (!base.deleted || dc !== base.deleteClock) changed = true;
    base.deleted = true;
    base.deleteClock = dc;
  } else {
    for (const [name, value] of Object.entries(body.fields)) {
      const cur = base.fields[name];
      if (!cur || env.clock > cur.clock) {
        base.fields[name] = { value, clock: env.clock };
        changed = true;
      }
    }
  }
  const updated = maxClock(base.updatedClock, env.clock);
  if (updated !== base.updatedClock) {
    base.updatedClock = updated;
    changed = true;
  }
  return { obj: base, changed };
}

export function maxFieldClock(obj: StoredObject): string {
  let m = '';
  for (const f of Object.values(obj.fields)) if (f.clock > m) m = f.clock;
  return m;
}

/** FR-011 / FR-012: a tombstone hides the object unless its type opts into "edit resurrects". */
export function isVisible(obj: StoredObject, resurrectingTypes: ReadonlySet<string>): boolean {
  if (!obj.deleted) return true;
  return resurrectingTypes.has(obj.type) && obj.deleteClock !== null && maxFieldClock(obj) > obj.deleteClock;
}

export function toSyncable(obj: StoredObject): SyncableObject {
  const fields: Record<string, JSONValue> = {};
  for (const [name, f] of Object.entries(obj.fields)) if (!isUnset(f.value)) fields[name] = f.value;
  return { id: obj.id, type: obj.type, space: obj.space, schemaVersion: obj.schemaVersion, fields };
}

/**
 * State-based join of two copies of an object: the same result as merging the packets behind both.
 * Used to install snapshots (idempotent, order independent).
 */
export function joinObjects(a: StoredObject | undefined, b: StoredObject): StoredObject {
  if (!a) return structuredClone(b);
  const out = structuredClone(a);
  if (b.createdClock < out.createdClock) {
    out.createdClock = b.createdClock;
    out.type = b.type;
    out.space = b.space;
  }
  if (b.schemaVersion > out.schemaVersion) out.schemaVersion = b.schemaVersion;
  for (const [name, f] of Object.entries(b.fields)) {
    const cur = out.fields[name];
    if (!cur || f.clock > cur.clock) out.fields[name] = structuredClone(f);
  }
  out.deleted = out.deleted || b.deleted;
  out.deleteClock = out.deleteClock === null ? b.deleteClock : b.deleteClock === null ? out.deleteClock : maxClock(out.deleteClock, b.deleteClock);
  out.updatedClock = maxClock(out.updatedClock, b.updatedClock);
  return out;
}

export function isStoredObject(o: unknown): o is StoredObject {
  const x = o as StoredObject;
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof x.id === 'string' &&
    typeof x.type === 'string' &&
    typeof x.space === 'string' &&
    Number.isInteger(x.schemaVersion) &&
    typeof x.fields === 'object' &&
    x.fields !== null &&
    Object.values(x.fields).every((f) => typeof f === 'object' && f !== null && typeof f.clock === 'string') &&
    typeof x.deleted === 'boolean' &&
    (x.deleteClock === null || typeof x.deleteClock === 'string') &&
    typeof x.createdClock === 'string' &&
    typeof x.updatedClock === 'string'
  );
}
