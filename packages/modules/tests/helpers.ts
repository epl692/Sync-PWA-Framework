/** Shared helpers for @sync/modules tests. */
import type { JSONValue, Query } from '@sync/core';
import type { ModuleDefinition, ModuleContext, ProjectedObject, HostEvent, ObjectTypeDef } from '../src/types';

export const mod = (id: string, over: Partial<ModuleDefinition> = {}): ModuleDefinition => ({ id, version: '1.0.0', ...over });

export const simpleType = (name: string, over: Partial<ObjectTypeDef> = {}): ObjectTypeDef => ({
  name,
  versions: [{ version: 1, fields: { title: { type: 'string', required: true, maxLength: 100 }, done: { type: 'boolean', default: false } } }],
  ...over,
});

export function collectEvents(host: { on(cb: (e: HostEvent) => void): () => void }): HostEvent[] {
  const events: HostEvent[] = [];
  host.on((e) => events.push(e));
  return events;
}

/** A Query whose emissions the test controls. */
export function controlledQuery<T = ProjectedObject>() {
  const subs = new Set<(r: T[]) => void>();
  let current: T[] = [];
  const stats = { subscribed: 0, unsubscribed: 0 };
  const query: Query<T> = {
    subscribe(cb) {
      stats.subscribed++;
      subs.add(cb);
      cb(current);
      return () => {
        stats.unsubscribed++;
        subs.delete(cb);
      };
    },
    once: async () => current,
    [Symbol.asyncIterator]() {
      throw new Error('not used');
    },
  };
  return {
    query,
    stats,
    emit(rows: T[]) {
      current = rows;
      for (const cb of [...subs]) cb(rows);
    },
    get active() {
      return subs.size;
    },
  };
}

/** A fake ModuleContext whose data.query returns the given controlled query. */
export function fakeCtx(query: Query<ProjectedObject>, over: Partial<ModuleContext> = {}): ModuleContext {
  const calls: unknown[] = [];
  const ctx = {
    moduleId: 'fake',
    version: '1.0.0',
    settings: {},
    data: {
      query: (spec: unknown) => {
        calls.push(spec);
        return query;
      },
    },
    spaces: { list: async () => [] },
    ui: {},
    log: { info() {}, warn() {}, error() {} },
    ...over,
  } as unknown as ModuleContext & { calls?: unknown[] };
  (ctx as unknown as { calls: unknown[] }).calls = calls;
  return ctx;
}

export const row = (id: string, fields: Record<string, JSONValue> = {}): ProjectedObject => ({ id, type: 'fake.t', space: 's1', fields, seenVersion: 1 });

/** Manual requestAnimationFrame: frames run when the test says so. */
export function manualFrames() {
  const queue: Array<() => void> = [];
  const prev = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    queue.push(() => cb(0));
    return queue.length;
  }) as typeof requestAnimationFrame;
  return {
    flush() {
      const run = queue.splice(0);
      run.forEach((f) => f());
      return run.length;
    },
    get pending() {
      return queue.length;
    },
    restore() {
      globalThis.requestAnimationFrame = prev;
    },
  };
}

/** A Web Locks stand-in: exclusive, FIFO. */
export function fakeLocks() {
  const held = new Map<string, Promise<unknown>>();
  const requested: string[] = [];
  return {
    requested,
    request(name: string, cb: () => Promise<unknown>): Promise<unknown> {
      requested.push(name);
      const prev = held.get(name) ?? Promise.resolve();
      const run = prev.then(() => cb());
      held.set(name, run.catch(() => undefined));
      return run;
    },
  };
}

export const tick = (n = 20) => new Promise<void>((r) => { let i = 0; const step = () => (++i >= n ? r() : queueMicrotask(step)); step(); });
