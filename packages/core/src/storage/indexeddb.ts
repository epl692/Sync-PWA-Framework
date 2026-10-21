import {
  INDEX_FIELD,
  STORE_NAMES,
  StorageQuotaError,
  type IndexName,
  type Range,
  type StorageAdapter,
  type StorageTx,
  type StoreName,
} from './types';

export interface IndexedDbStorageOptions {
  /** Database name. */
  name?: string;
  /** Injected for tests or non-window contexts. Defaults to globalThis.indexedDB. */
  factory?: IDBFactory;
}

const DB_VERSION = 1;

function mapError(e: unknown): unknown {
  const name = (e as { name?: string } | null)?.name;
  return name === 'QuotaExceededError' ? new StorageQuotaError() : e;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(mapError(r.error));
  });
}

function toKeyRange(r?: Range): IDBKeyRange | undefined {
  if (!r || (r.gte === undefined && r.lt === undefined)) return undefined;
  if (r.gte !== undefined && r.lt !== undefined) return IDBKeyRange.bound(r.gte, r.lt, false, true);
  if (r.gte !== undefined) return IDBKeyRange.lowerBound(r.gte);
  return IDBKeyRange.upperBound(r.lt!, true);
}

class IndexedDbStorage implements StorageAdapter {
  constructor(private readonly db: IDBDatabase) {}

  async transaction<R>(stores: readonly StoreName[], mode: 'readonly' | 'readwrite', fn: (tx: StorageTx) => Promise<R>): Promise<R> {
    const t = this.db.transaction([...stores], mode);
    const done = new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(mapError(t.error));
      t.onabort = () => reject(mapError(t.error) ?? new DOMException('Transaction aborted', 'AbortError'));
    });
    done.catch(() => undefined); // avoid unhandled-rejection noise; awaited below
    const guard = (s: StoreName) => {
      if (!stores.includes(s)) throw new Error(`store ${s} is not part of this transaction`);
      return t.objectStore(s);
    };
    const tx: StorageTx = {
      get: async <T>(s: StoreName, key: string) => (await req(guard(s).get(key))) as T | undefined,
      put: async (s, key, value) => {
        await req(guard(s).put(value, key));
      },
      delete: async (s, key) => {
        await req(guard(s).delete(key));
      },
      scan: <T>(s: StoreName, o?: { index?: IndexName; range?: Range; limit?: number }) =>
        (async function* () {
          const store = guard(s);
          const source = o?.index ? store.index(o.index) : store;
          const out: { key: string; value: T }[] = [];
          await new Promise<void>((resolve, reject) => {
            const cursorReq = source.openCursor(toKeyRange(o?.range));
            cursorReq.onerror = () => reject(mapError(cursorReq.error));
            cursorReq.onsuccess = () => {
              const c = cursorReq.result;
              if (!c || (o?.limit !== undefined && out.length >= o.limit)) return resolve();
              out.push({ key: String(c.primaryKey), value: c.value as T });
              c.continue();
            };
          });
          yield* out;
        })(),
    };

    let result: R;
    try {
      result = await fn(tx);
    } catch (e) {
      try {
        t.abort();
      } catch {
        // already finished
      }
      await done.catch(() => undefined);
      throw mapError(e);
    }
    await done;
    return result;
  }

  async estimate() {
    const est = await globalThis.navigator?.storage?.estimate?.();
    return est ? { usageBytes: est.usage ?? 0, quotaBytes: est.quota ?? 0 } : undefined;
  }

  async persist() {
    return (await globalThis.navigator?.storage?.persist?.()) ?? false;
  }

  async close() {
    this.db.close();
  }
}

export async function createIndexedDbStorage(opts: IndexedDbStorageOptions = {}): Promise<StorageAdapter> {
  const factory = opts.factory ?? globalThis.indexedDB;
  if (!factory) throw new Error('IndexedDB is not available in this environment');
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = factory.open(opts.name ?? 'sync-core', DB_VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of STORE_NAMES) {
        const store = d.createObjectStore(s);
        for (const [idx, field] of Object.entries(INDEX_FIELD)) store.createIndex(idx, field);
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return new IndexedDbStorage(db);
}
