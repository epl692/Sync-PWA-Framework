import type { ObjectCache } from '../store/cache';
import { isVisible, toSyncable, type StoredObject } from '../store/objects';
import type { Query, QuerySpec, SyncableObject } from '../types';

export interface Change {
  id: string;
  types: string[];
}

interface Active {
  spec: QuerySpec;
  cb: (r: SyncableObject[]) => void;
  sig: string;
  ids: Set<string>;
}

/** Reactive queries over the in-memory object cache. Emissions are coalesced per microtask. */
export class QueryEngine {
  private active = new Set<Active>();
  private pending: Change[] = [];
  private scheduled = false;
  private held = 0;

  constructor(
    private readonly cache: ObjectCache,
    private readonly resurrecting: ReadonlySet<string>,
  ) {}

  private evaluate(spec: QuerySpec): StoredObject[] {
    let candidates: Iterable<StoredObject>;
    if (spec.id !== undefined) {
      const o = this.cache.get(spec.id);
      candidates = o ? [o] : [];
    } else if (spec.type !== undefined) {
      candidates = this.cache.ofType(spec.type);
    } else {
      candidates = this.cache.all();
    }
    const out: StoredObject[] = [];
    for (const o of candidates) {
      if (spec.type !== undefined && o.type !== spec.type) continue;
      if (spec.space !== undefined && o.space !== spec.space) continue;
      // A-5: `$`-prefixed types are system objects; only an exact type or id query sees them.
      if (o.type.startsWith('$') && spec.type !== o.type && spec.id === undefined) continue;
      if (!isVisible(o, this.resurrecting)) continue;
      if (spec.where && !spec.where(toSyncable(o, spec.withClocks))) continue;
      out.push(o);
    }
    out.sort((a, b) => (a.createdClock < b.createdClock ? -1 : a.createdClock > b.createdClock ? 1 : a.id < b.id ? -1 : 1));
    return out;
  }

  private static signature(objs: StoredObject[]): string {
    return objs.map((o) => `${o.id}@${o.updatedClock}`).join('|');
  }

  once(spec: QuerySpec): SyncableObject[] {
    return this.evaluate(spec).map((o) => toSyncable(o, spec.withClocks));
  }

  query(spec: QuerySpec): Query {
    const subscribe = (cb: (r: SyncableObject[]) => void): (() => void) => {
      const objs = this.evaluate(spec);
      const a: Active = { spec, cb, sig: QueryEngine.signature(objs), ids: new Set(objs.map((o) => o.id)) };
      this.active.add(a);
      cb(objs.map((o) => toSyncable(o, spec.withClocks)));
      return () => void this.active.delete(a);
    };
    return {
      subscribe,
      once: async () => this.once(spec),
      [Symbol.asyncIterator]() {
        const queue: SyncableObject[][] = [];
        let waiter: ((v: IteratorResult<SyncableObject[]>) => void) | undefined;
        let done = false;
        const unsub = subscribe((r) => {
          if (waiter) {
            const w = waiter;
            waiter = undefined;
            w({ value: r, done: false });
          } else queue.push(r);
        });
        return {
          next: () =>
            queue.length
              ? Promise.resolve({ value: queue.shift()!, done: false })
              : done
                ? Promise.resolve({ value: undefined, done: true })
                : new Promise<IteratorResult<SyncableObject[]>>((res) => (waiter = res)),
          return: async () => {
            done = true;
            unsub();
            waiter?.({ value: undefined, done: true });
            return { value: undefined, done: true };
          },
        } as AsyncIterator<SyncableObject[]>;
      },
    };
  }

  /** Record that these objects changed. Re-evaluation happens once, in a microtask. */
  notify(changes: Change[]): void {
    if (!changes.length) return;
    this.pending.push(...changes);
    if (this.scheduled || this.held > 0) return;
    this.scheduled = true;
    queueMicrotask(() => this.flush());
  }

  /** Hold emissions while a batch of packets is applied, so a batch causes one re-evaluation. */
  async batch<T>(fn: () => Promise<T>): Promise<T> {
    this.held++;
    try {
      return await fn();
    } finally {
      this.held--;
      if (this.held === 0 && this.pending.length && !this.scheduled) {
        this.scheduled = true;
        queueMicrotask(() => this.flush());
      }
    }
  }

  private flush(): void {
    this.scheduled = false;
    const changes = this.pending;
    this.pending = [];
    const ids = new Set(changes.map((c) => c.id));
    const types = new Set(changes.flatMap((c) => c.types));
    for (const a of [...this.active]) {
      const s = a.spec;
      if (s.id !== undefined && !ids.has(s.id)) continue;
      if (s.type !== undefined && !types.has(s.type) && ![...a.ids].some((i) => ids.has(i))) continue;
      const objs = this.evaluate(s);
      const sig = QueryEngine.signature(objs);
      if (sig === a.sig) continue;
      a.sig = sig;
      a.ids = new Set(objs.map((o) => o.id));
      a.cb(objs.map((o) => toSyncable(o, s.withClocks)));
    }
  }

  /** Re-evaluate every live query (visibility rules changed, C-1). Emits only where the result changed. */
  refresh(): void {
    for (const a of [...this.active]) {
      const objs = this.evaluate(a.spec);
      const sig = QueryEngine.signature(objs);
      if (sig === a.sig) continue;
      a.sig = sig;
      a.ids = new Set(objs.map((o) => o.id));
      a.cb(objs.map((o) => toSyncable(o, a.spec.withClocks)));
    }
  }
}
