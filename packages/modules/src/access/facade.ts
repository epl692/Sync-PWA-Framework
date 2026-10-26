/** The only way a module reads and writes objects (FR-012, research R-10). Wraps the core with projection and, from US5, access checks. */

import type { JSONValue, ObjectId, Query, SpaceId, SyncCore, SyncableObject, UNSET } from '@sync/core';
import { UNSET as UNSET_MARK } from '@sync/core';
import { project } from '../schema/project';
import { prepareWrite } from '../schema/prepare-write';
import { SchemaValidationError, type RegisteredType } from '../schema/types';
import { validateBody } from '../schema/validate';
import type { SchemaRegistry } from '../schema/registry';
import type { DataFacade, FacadeQuerySpec, HostEvent, ProjectedObject } from '../types';

/** Decides what a module may touch. The default allows everything; US5 supplies the real one. */
export interface Guard {
  type(mode: 'r' | 'rw', type: string): void;
  space(mode: 'r' | 'rw', space: SpaceId): Promise<void> | void;
}
export const allowAll: Guard = { type() {}, space() {} };

export interface FacadeOptions {
  core: SyncCore;
  registry: SchemaRegistry;
  moduleId: string;
  emit(e: HostEvent): void;
  guard?: Guard;
}

export function createFacade(o: FacadeOptions): DataFacade {
  const { core, registry } = o;
  const guard = o.guard ?? allowAll;

  const reported = new Set<string>();
  /** Objects of types no module has registered are not exposed (they are kept, but have no schema). */
  const projectOne = (obj: SyncableObject): ProjectedObject | undefined => {
    const reg = registry.get(obj.type);
    if (!reg) return undefined;
    const p = project(reg, obj);
    for (const v of p.violations ?? []) {
      const key = `${obj.id}|${v.field}|${v.detail}`;
      if (reported.has(key)) continue; // queries re-emit on every change; report each problem once
      reported.add(key);
      o.emit({ kind: 'schema:violation', type: obj.type, obj: obj.id, field: v.field, detail: v.detail });
    }
    return p;
  };

  /** Refuse a write before any packet exists, with the field and the reason (US2-1). */
  const checkWrite = (reg: RegisteredType, op: 'create' | 'update', fields: Record<string, JSONValue | typeof UNSET_MARK>) => {
    const plain: Record<string, JSONValue> = {};
    for (const [k, v] of Object.entries(fields)) plain[k] = v === UNSET_MARK ? { $unset: true } : (v as JSONValue);
    const prepared = prepareWrite(reg, op, plain);
    const r = validateBody(reg, { op, schemaVersion: prepared.schemaVersion, fields: prepared.fields });
    if (!r.ok) throw new SchemaValidationError(reg.type, r.field, r.detail);
    return prepared;
  };

  /** Same error for "no such object" and "type not known", so the answer reveals nothing (R-10). */
  const known = async (id: ObjectId): Promise<SyncableObject> => {
    const cur = await core.get(id, { withClocks: true });
    if (!cur || !registry.get(cur.type)) throw new Error(`object "${id}" not found`);
    return cur;
  };

  return {
    async create(space: SpaceId, type: string, fields: Record<string, JSONValue>) {
      const reg = registry.get(type);
      if (!reg) throw new Error(`type "${type}" is not registered`);
      guard.type('rw', type);
      await guard.space('rw', space);
      const prepared = checkWrite(reg, 'create', fields);
      const obj = await core.create(space, type, prepared.fields, { schemaVersion: prepared.schemaVersion });
      return projectOne(obj)!;
    },

    async update(id: ObjectId, fields: Record<string, JSONValue | typeof UNSET>) {
      const cur = await known(id);
      guard.type('rw', cur.type);
      await guard.space('rw', cur.space);
      const prepared = checkWrite(registry.get(cur.type)!, 'update', fields);
      const obj = await core.update(id, prepared.fields, { schemaVersion: prepared.schemaVersion });
      return projectOne(obj)!;
    },

    async remove(id: ObjectId) {
      const cur = await known(id);
      guard.type('rw', cur.type);
      await guard.space('rw', cur.space);
      await core.remove(id);
    },

    async get(id: ObjectId) {
      const obj = await core.get(id, { withClocks: true });
      if (!obj) return undefined;
      const p = projectOne(obj);
      if (!p) return undefined;
      guard.type('r', obj.type);
      await guard.space('r', obj.space);
      return p;
    },

    query(spec: FacadeQuerySpec): Query<ProjectedObject> {
      if (spec.type === undefined && spec.id === undefined) throw new Error('a query needs a type or an id');
      if (spec.type !== undefined) guard.type('r', spec.type);
      const q = core.query({ space: spec.space, type: spec.type, id: spec.id, withClocks: true });
      const map = (rows: SyncableObject[]): ProjectedObject[] =>
        rows.flatMap((r) => {
          const p = projectOne(r);
          return p && (!spec.where || spec.where(p)) ? [p] : [];
        });
      return {
        subscribe: (cb) => q.subscribe((rows) => cb(map(rows))),
        once: async () => map(await q.once()),
        [Symbol.asyncIterator]() {
          const it = q[Symbol.asyncIterator]();
          return {
            next: async () => {
              const r = await it.next();
              return r.done ? r : { value: map(r.value), done: false };
            },
            return: async () => (await it.return?.()) ?? { value: undefined, done: true },
          } as AsyncIterator<ProjectedObject[]>;
        },
      };
    },

    undo: (id: ObjectId) => core.undo(id),
    history: (id: ObjectId) => core.history(id),
  };
}
