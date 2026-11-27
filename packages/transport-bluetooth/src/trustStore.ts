/**
 * Pinned Hubs (data-model "TrustedHubRecord"): which Hubs the user confirmed, and their public keys. A pinned key that later
 * differs blocks the connection until the user confirms again. IndexedDB database `sync-bluetooth-v1`; every storage access is
 * wrapped, so a browser that blocks storage degrades to "no pinned Hubs" (the user simply confirms again), never to a crash.
 */

export interface TrustedHub {
  fingerprint: string;
  name: string;
  autoReconnect: boolean;
  lastConnected?: number;
}

export type PinnedHub = TrustedHub & {
  publicKey: Uint8Array;
  /** The browser's own identity for the device, for reconnecting without the chooser. Not portable between browsers. */
  browserDeviceId?: string;
};

export interface TrustedHubStore {
  list(): Promise<TrustedHub[]>;
  get(fingerprint: string): Promise<PinnedHub | undefined>;
  put(h: PinnedHub): Promise<void>;
  forget(fingerprint: string): Promise<void>;
}

export const DB_NAME = 'sync-bluetooth-v1';
const STORE = 'hubs';

export function createMemoryTrustStore(): TrustedHubStore {
  const m = new Map<string, PinnedHub>();
  const copy = (h: PinnedHub): PinnedHub => ({ ...h, publicKey: h.publicKey.slice() });
  const pub = ({ publicKey: _p, browserDeviceId: _b, ...rest }: PinnedHub): TrustedHub => rest;
  return {
    async list() {
      return [...m.values()].map(pub);
    },
    async get(f) {
      const h = m.get(f);
      return h && copy(h);
    },
    async put(h) {
      m.set(h.fingerprint, copy(h));
    },
    async forget(f) {
      m.delete(f);
    },
  };
}

type Idb = IDBFactory | undefined;

function openDb(idb: Idb): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!idb) return reject(new Error('IndexedDB unavailable'));
    const req = idb.open(DB_NAME, 1);
    req.onupgradeneeded = () => void req.result.createObjectStore(STORE, { keyPath: 'fingerprint' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r.result);
    t.onerror = () => reject(t.error ?? new Error('IndexedDB transaction failed'));
    t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** IndexedDB-backed store. `idb` defaults to the global `indexedDB`. */
export function createIndexedDbTrustStore(idb: Idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB): TrustedHubStore {
  let db: Promise<IDBDatabase> | undefined;
  const open = () => (db ??= openDb(idb).catch((e) => {
    db = undefined;
    throw e;
  }));
  const safe = async <T>(fallback: T, fn: (d: IDBDatabase) => Promise<T>): Promise<T> => {
    try {
      return await fn(await open());
    } catch {
      return fallback;
    }
  };
  const pub = ({ publicKey: _p, browserDeviceId: _b, ...rest }: PinnedHub): TrustedHub => rest;
  return {
    list: () => safe([], async (d) => ((await tx(d, 'readonly', (s) => s.getAll())) as PinnedHub[]).map(pub)),
    get: (f) =>
      safe(undefined as PinnedHub | undefined, async (d) => {
        const h = (await tx(d, 'readonly', (s) => s.get(f))) as PinnedHub | undefined;
        return h && { ...h, publicKey: new Uint8Array(h.publicKey) };
      }),
    put: (h) => safe(undefined, async (d) => void (await tx(d, 'readwrite', (s) => s.put({ ...h })))),
    forget: (f) => safe(undefined, async (d) => void (await tx(d, 'readwrite', (s) => s.delete(f)))),
  };
}
