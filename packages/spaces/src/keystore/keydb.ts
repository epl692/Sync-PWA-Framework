/** The local-only `sync-keys` database (research R-16). Never synced, snapshotted or exported. */

export type KeyStoreName = 'device' | 'epoch-keys' | 'counters' | 'invites-local';
export const KEY_STORES: readonly KeyStoreName[] = ['device', 'epoch-keys', 'counters', 'invites-local'];

export interface KeyDb {
  get<T>(store: KeyStoreName, key: string): Promise<T | undefined>;
  put<T>(store: KeyStoreName, key: string, value: T): Promise<void>;
  delete(store: KeyStoreName, key: string): Promise<void>;
  all<T>(store: KeyStoreName): Promise<Array<{ key: string; value: T }>>;
  close(): Promise<void>;
}

export function memoryKeyDb(): KeyDb {
  const stores = new Map<KeyStoreName, Map<string, unknown>>(KEY_STORES.map((s) => [s, new Map()]));
  // structuredClone keeps the behavior of a real database: callers never share references with it.
  const clone = <T>(v: T): T => structuredClone(v);
  return {
    async get<T>(s: KeyStoreName, k: string) {
      const v = stores.get(s)!.get(k);
      return v === undefined ? undefined : clone(v as T);
    },
    async put(s, k, v) {
      stores.get(s)!.set(k, clone(v));
    },
    async delete(s, k) {
      stores.get(s)!.delete(k);
    },
    async all<T>(s: KeyStoreName) {
      return [...stores.get(s)!.entries()].map(([key, value]) => ({ key, value: clone(value as T) }));
    },
    async close() {},
  };
}

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

export interface IndexedDbKeyDbOptions {
  name?: string;
  /** Injected for tests. Defaults to globalThis.indexedDB. */
  factory?: IDBFactory;
}

export async function indexedDbKeyDb(opts: IndexedDbKeyDbOptions = {}): Promise<KeyDb> {
  const factory = opts.factory ?? globalThis.indexedDB;
  if (!factory) throw new Error('IndexedDB is not available');
  const open = factory.open(opts.name ?? 'sync-keys', 1);
  open.onupgradeneeded = () => {
    for (const s of KEY_STORES) if (!open.result.objectStoreNames.contains(s)) open.result.createObjectStore(s);
  };
  const db = await req(open);
  const store = (s: KeyStoreName, mode: IDBTransactionMode) => db.transaction(s, mode).objectStore(s);
  return {
    get: async <T>(s: KeyStoreName, k: string) => (await req(store(s, 'readonly').get(k))) as T | undefined,
    async put(s, k, v) {
      await req(store(s, 'readwrite').put(v, k));
    },
    async delete(s, k) {
      await req(store(s, 'readwrite').delete(k));
    },
    async all<T>(s: KeyStoreName) {
      const st = store(s, 'readonly');
      const [keys, values] = await Promise.all([req(st.getAllKeys()), req(st.getAll())]);
      return keys.map((key, i) => ({ key: String(key), value: values[i] as T }));
    },
    async close() {
      db.close();
    },
  };
}
