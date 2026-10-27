/**
 * IndexedDB BlobStorage (database `sync-blobs-v1`): `blobs` (records), `chunks` (ciphertext, key `${id}:${index}` zero
 * padded so keys sort by index), `refs` (reference index), `meta`. A separate database from the packet store on purpose:
 * large binary data must not affect packet storage, quota handling or compaction (research R-05).
 */

import { StorageQuotaError } from '@sync/core';
import type { BlobStorage, StoredBlob } from '../types';

export interface IndexedDbBlobStorageOptions {
  /** Database name. Default `sync-blobs-v1`. */
  name?: string;
  /** Injected for tests or non-window contexts. Defaults to globalThis.indexedDB. */
  factory?: IDBFactory;
}

const DB_VERSION = 1;
const STORES = ['blobs', 'chunks', 'refs', 'meta'] as const;
const USED = 'usedBytes';

const pad = (i: number) => String(i).padStart(5, '0');
const chunkKey = (id: string, i: number) => `${id}:${pad(i)}`;
const range = (id: string) => IDBKeyRange.bound(`${id}:`, `${id}:￿`);

function mapError(e: unknown): unknown {
  return (e as { name?: string } | null)?.name === 'QuotaExceededError' ? new StorageQuotaError() : e;
}
function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(mapError(r.error));
  });
}

type Tx = IDBTransaction;

class IndexedDbBlobStorage implements BlobStorage {
  constructor(private readonly db: IDBDatabase) {}

  /** Run `fn` in one transaction; resolves after the transaction commits, rejects (state unchanged) on any failure. */
  private run<R>(stores: readonly (typeof STORES)[number][], mode: IDBTransactionMode, fn: (t: Tx) => Promise<R>): Promise<R> {
    const t = this.db.transaction([...stores], mode);
    const done = new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(mapError(t.error));
      t.onabort = () => reject(mapError(t.error) ?? new DOMException('Transaction aborted', 'AbortError'));
    });
    done.catch(() => undefined);
    return (async () => {
      try {
        const r = await fn(t);
        await done;
        return r;
      } catch (e) {
        try {
          t.abort();
        } catch {
          // already finished
        }
        throw mapError(e);
      }
    })();
  }

  private async addUsed(t: Tx, delta: number): Promise<void> {
    if (delta === 0) return;
    const cur = ((await req(t.objectStore('meta').get(USED))) as number | undefined) ?? 0;
    await req(t.objectStore('meta').put(cur + delta, USED));
  }

  getBlob(id: string): Promise<StoredBlob | undefined> {
    return this.run(['blobs'], 'readonly', async (t) => (await req(t.objectStore('blobs').get(id))) as StoredBlob | undefined);
  }
  putBlob(rec: StoredBlob): Promise<void> {
    return this.run(['blobs'], 'readwrite', async (t) => void (await req(t.objectStore('blobs').put(rec, rec.id))));
  }
  async *listBlobs(o?: { orderBy?: 'lastAccessAt' | 'createdAt'; limit?: number }): AsyncIterable<StoredBlob> {
    const all = (await this.run(['blobs'], 'readonly', async (t) => (await req(t.objectStore('blobs').getAll())) as StoredBlob[]));
    const key = o?.orderBy ?? 'lastAccessAt';
    all.sort((a, b) => a[key] - b[key] || (a.id < b.id ? -1 : 1));
    yield* o?.limit !== undefined ? all.slice(0, o.limit) : all;
  }
  deleteBlob(id: string): Promise<void> {
    return this.run(['blobs', 'chunks', 'refs', 'meta'], 'readwrite', async (t) => {
      await req(t.objectStore('blobs').delete(id));
      await req(t.objectStore('refs').delete(id));
      await this.addUsed(t, -(await this.dropChunks(t, id)));
    });
  }

  private async dropChunks(t: Tx, id: string): Promise<number> {
    const store = t.objectStore('chunks');
    let freed = 0;
    await new Promise<void>((resolve, reject) => {
      const c = store.openCursor(range(id));
      c.onerror = () => reject(mapError(c.error));
      c.onsuccess = () => {
        const cur = c.result;
        if (!cur) return resolve();
        freed += (cur.value as Uint8Array).byteLength;
        cur.delete();
        cur.continue();
      };
    });
    return freed;
  }

  putChunk(id: string, index: number, stored: Uint8Array): Promise<void> {
    return this.run(['chunks', 'meta'], 'readwrite', async (t) => {
      const key = chunkKey(id, index);
      if ((await req(t.objectStore('chunks').count(key))) > 0) return; // idempotent
      await req(t.objectStore('chunks').put(stored.slice(), key));
      await this.addUsed(t, stored.byteLength);
    });
  }
  getChunk(id: string, index: number): Promise<Uint8Array | undefined> {
    return this.run(['chunks'], 'readonly', async (t) => {
      const v = (await req(t.objectStore('chunks').get(chunkKey(id, index)))) as Uint8Array | ArrayBuffer | undefined;
      return v === undefined ? undefined : v instanceof Uint8Array ? v : new Uint8Array(v);
    });
  }
  presentChunks(id: string): Promise<number[]> {
    return this.run(['chunks'], 'readonly', async (t) => {
      const keys = (await req(t.objectStore('chunks').getAllKeys(range(id)))) as string[];
      return keys.map((k) => Number(k.slice(id.length + 1))).sort((a, b) => a - b);
    });
  }
  deleteChunks(id: string): Promise<number> {
    return this.run(['chunks', 'meta'], 'readwrite', async (t) => {
      const freed = await this.dropChunks(t, id);
      await this.addUsed(t, -freed);
      return freed;
    });
  }
  moveChunks(from: string, to: string): Promise<void> {
    if (from === to) return Promise.resolve();
    return this.run(['chunks', 'meta'], 'readwrite', async (t) => {
      const store = t.objectStore('chunks');
      const keys = (await req(store.getAllKeys(range(from)))) as string[];
      let dup = 0;
      for (const k of keys) {
        const idx = k.slice(from.length + 1);
        const v = (await req(store.get(k))) as Uint8Array;
        const target = `${to}:${idx}`;
        if ((await req(store.count(target))) > 0) dup += v.byteLength;
        else await req(store.put(v, target));
        await req(store.delete(k));
      }
      await this.addUsed(t, -dup);
    });
  }

  getRefs(id: string): Promise<string[]> {
    return this.run(['refs'], 'readonly', async (t) => ((await req(t.objectStore('refs').get(id))) as string[] | undefined) ?? []);
  }
  setRefs(id: string, objects: string[]): Promise<void> {
    return this.run(['refs'], 'readwrite', async (t) => {
      if (objects.length) await req(t.objectStore('refs').put([...objects], id));
      else await req(t.objectStore('refs').delete(id));
    });
  }
  getMeta<T>(key: string): Promise<T | undefined> {
    return this.run(['meta'], 'readonly', async (t) => (await req(t.objectStore('meta').get(`m:${key}`))) as T | undefined);
  }
  setMeta<T>(key: string, value: T): Promise<void> {
    return this.run(['meta'], 'readwrite', async (t) => void (await req(t.objectStore('meta').put(value, `m:${key}`))));
  }

  usedBytes(): Promise<number> {
    return this.run(['meta'], 'readonly', async (t) => ((await req(t.objectStore('meta').get(USED))) as number | undefined) ?? 0);
  }
  async estimate(): Promise<{ usageBytes: number; quotaBytes: number } | undefined> {
    const e = await globalThis.navigator?.storage?.estimate?.();
    return e && e.quota !== undefined && e.usage !== undefined ? { usageBytes: e.usage, quotaBytes: e.quota } : undefined;
  }
  async close(): Promise<void> {
    this.db.close();
  }
}

export async function createIndexedDbBlobStorage(opts: IndexedDbBlobStorageOptions = {}): Promise<BlobStorage> {
  const factory = opts.factory ?? globalThis.indexedDB;
  if (!factory) throw new Error('IndexedDB is not available in this environment');
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = factory.open(opts.name ?? 'sync-blobs-v1', DB_VERSION);
    r.onupgradeneeded = () => {
      for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return new IndexedDbBlobStorage(db);
}
