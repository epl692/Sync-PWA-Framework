/** The only way a module reads and writes objects (FR-012, research R-10). Wraps the core with projection and access checks. */

import { UNSET as UNSET_MARK, type JSONValue, type ObjectId, type Query, type SpaceId, type SyncCore, type SyncableObject, type UNSET } from '@sync/core';
import { prepareWrite } from '../schema/prepare-write';
import { project } from '../schema/project';
import type { SchemaRegistry } from '../schema/registry';
import { SchemaValidationError, type RegisteredType } from '../schema/types';
import { validateBody } from '../schema/validate';
import type { DataFacade, FacadeQuerySpec, HostEvent, ProjectedObject } from '../types';
import { allowAll, type Guard } from './guard';

export { allowAll, type Guard };

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
  /** Where objects this facade has seen live, so undo and history work for deleted objects too. */
  const seen = new Map<ObjectId, { type: string; space: SpaceId }>();

  /** Objects of types no module has registered are not exposed (they are kept, but have no schema). */
  const projectOne = (obj: SyncableObject): ProjectedObject | undefined => {
    const reg = registry.get(obj.type);
    if (!reg) return undefined;
    seen.set(obj.id, { type: obj.type, space: obj.space });
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

  /**
   * The object to change. "No such object", "type nobody registered", "type not declared" and "Space not
   * bound" are the same AccessDeniedError, so the module cannot probe for what it may not see.
   */
  const writable = async (id: ObjectId): Promise<SyncableObject> => {
    const cur = await core.get(id, { withClocks: true });
    const why = !cur ? 'no such object' : !registry.get(cur.type) ? `type ${cur.type} has no schema` : !guard.canType('rw', cur.type) ? `type ${cur.type} is not declared for write` : !guard.canSpace('rw', cur.space) ? `Space ${cur.space} is not bound for write` : undefined;
    if (why || !cur) guard.deny(`write object "${id}"`, why);
    return cur!;
  };

  /** Where an object lives, from what this facade has seen or from the core. */
  const locate = async (id: ObjectId): Promise<{ type: string; space: SpaceId } | undefined> => {
    const known = seen.get(id);
    if (known) return known;
    const cur = await core.get(id);
    return cur ? { type: cur.type, space: cur.space } : undefined;
  };

  return {
    async create(space: SpaceId, type: string, fields: Record<string, JSONValue>) {
      const reg = registry.get(type);
      if (!reg) throw new Error(`type "${type}" is not registered`);
      guard.type('rw', type);
      guard.space('rw', space);
      const prepared = checkWrite(reg, 'create', fields);
      const obj = await core.create(space, type, prepared.fields, { schemaVersion: prepared.schemaVersion });
      return projectOne(obj)!;
    },

    async update(id: ObjectId, fields: Record<string, JSONValue | typeof UNSET>) {
      const cur = await writable(id);
      const prepared = checkWrite(registry.get(cur.type)!, 'update', fields);
      const obj = await core.update(id, prepared.fields, { schemaVersion: prepared.schemaVersion });
      return projectOne(obj)!;
    },

    async remove(id: ObjectId) {
      await writable(id);
      await core.remove(id);
    },

    async get(id: ObjectId) {
      const obj = await core.get(id, { withClocks: true });
      if (!obj || !registry.get(obj.type)) return undefined;
      if (!guard.canType('r', obj.type) || !guard.canSpace('r', obj.space)) {
        // looks like "not found" to the module; the host hears about it
        try {
          guard.deny(`read object "${id}"`, `type ${obj.type} or Space ${obj.space} is not allowed`);
        } catch {
          return undefined;
        }
      }
      return projectOne(obj);
    },

    query(spec: FacadeQuerySpec): Query<ProjectedObject> {
      if (spec.type === undefined && spec.id === undefined) guard.deny('query without a type or an id');
      if (spec.type !== undefined) guard.type('r', spec.type);
      if (spec.space !== undefined) guard.space('r', spec.space);
      const q = core.query({ space: spec.space, type: spec.type, id: spec.id, withClocks: true });
      const map = (rows: SyncableObject[]): ProjectedObject[] =>
        rows.flatMap((r) => {
          if (!guard.canType('r', r.type) || !guard.canSpace('r', r.space)) return [];
          const p = projectOne(r);
          return p && (!spec.where || spec.where(p)) ? [p] : [];
        });
      return {
        subscribe: (cb) => {
          let last: SyncableObject[] = [];
          const unsub = q.subscribe((rows) => {
            last = rows;
            cb(map(rows));
          });
          // a Space bound or unbound changes what the same rows show
          const off = guard.onChange(() => cb(map(last)));
          return () => {
            off();
            unsub();
          };
        },
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

    async undo(id: ObjectId) {
      const at = await locate(id);
      if (!at || !guard.canType('rw', at.type) || !guard.canSpace('rw', at.space)) guard.deny(`write object "${id}"`, at ? `type ${at.type} or Space ${at.space} is not allowed` : 'no such object');
      await core.undo(id);
    },

    async history(id: ObjectId) {
      const at = await locate(id);
      if (!at || !guard.canType('r', at.type) || !guard.canSpace('r', at.space)) guard.deny(`read object "${id}"`, at ? `type ${at.type} or Space ${at.space} is not allowed` : 'no such object');
      return core.history(id);
    },
  };
}
