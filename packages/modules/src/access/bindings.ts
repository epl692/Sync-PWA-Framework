/**
 * Which Spaces a module may use on THIS device (access `bound`). A device setting, not synced application data
 * (Principle II): it lives in its own IndexedDB database, never in the object store.
 */

export type BindingMode = 'r' | 'rw';

export interface BindingRecord {
  module: string;
  space: string;
  mode: BindingMode;
}

export interface BindingDb {
  load(): Promise<BindingRecord[]>;
  put(r: BindingRecord): Promise<void>;
  delete(module: string, space: string): Promise<void>;
}

export function memoryBindingDb(): BindingDb {
  const rows = new Map<string, BindingRecord>();
  const key = (m: string, s: string) => `${m}\u0000${s}`;
  return {
    load: async () => [...rows.values()],
    put: async (r) => void rows.set(key(r.module, r.space), r),
    delete: async (m, s) => void rows.delete(key(m, s)),
  };
}

export interface IndexedDbBindingOptions {
  factory?: IDBFactory;
  /** Default "sync-modules". */
  name?: string;
}

export function indexedDbBindingDb(o: IndexedDbBindingOptions = {}): BindingDb {
  let opened: Promise<IDBDatabase> | undefined;
  const open = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const factory = o.factory ?? globalThis.indexedDB;
      if (!factory) return reject(new Error('IndexedDB is not available'));
      const req = factory.open(o.name ?? 'sync-modules', 1);
      req.onupgradeneeded = () => void req.result.createObjectStore('bindings', { keyPath: ['module', 'space'] });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction('bindings', mode);
      const req = fn(tx.objectStore('bindings'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  return {
    load: () => run('readonly', (s) => s.getAll() as IDBRequest<BindingRecord[]>),
    put: async (r) => void (await run('readwrite', (s) => s.put(r))),
    delete: async (m, s) => void (await run('readwrite', (st) => st.delete([m, s]))),
  };
}

const key = (m: string, s: string) => `${m}\u0000${s}`;

export class Bindings {
  private readonly modes = new Map<string, BindingMode>();
  private readonly listeners = new Set<() => void>();

  private constructor(private readonly db: BindingDb) {}

  static async open(db: BindingDb): Promise<Bindings> {
    const b = new Bindings(db);
    for (const r of await db.load()) b.modes.set(key(r.module, r.space), r.mode);
    return b;
  }

  /** In memory only: nothing persists. For tests and for hosts with no IndexedDB. */
  static memory(): Bindings {
    return new Bindings(memoryBindingDb());
  }

  mode(module: string, space: string): BindingMode | undefined {
    return this.modes.get(key(module, space));
  }

  /** Does the binding allow what is needed? `rw` covers `r`. */
  allows(module: string, space: string, need: BindingMode): boolean {
    const m = this.mode(module, space);
    return m === 'rw' || (m === 'r' && need === 'r');
  }

  spacesOf(module: string, need: BindingMode): string[] {
    const prefix = `${module}\u0000`;
    return [...this.modes.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).filter((s) => this.allows(module, s, need));
  }

  async set(module: string, space: string, mode: BindingMode): Promise<void> {
    if (mode !== 'r' && mode !== 'rw') throw new Error(`binding mode ${JSON.stringify(mode)} must be "r" or "rw"`);
    if (this.mode(module, space) === mode) return;
    this.modes.set(key(module, space), mode);
    await this.db.put({ module, space, mode });
    this.changed();
  }

  async remove(module: string, space: string): Promise<void> {
    if (!this.modes.delete(key(module, space))) return;
    await this.db.delete(module, space);
    this.changed();
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  private changed(): void {
    for (const cb of [...this.listeners]) cb();
  }
}
