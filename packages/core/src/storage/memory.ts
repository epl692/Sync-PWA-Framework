import {
  INDEX_FIELD,
  StorageQuotaError,
  type IndexName,
  type Range,
  type StorageAdapter,
  type StorageTx,
  type StoreName,
} from './types';

const DELETED = Symbol('deleted');

export function estimateSize(v: unknown): number {
  if (v === null || v === undefined) return 1;
  switch (typeof v) {
    case 'string':
      return v.length + 2;
    case 'number':
    case 'boolean':
      return 8;
    case 'object': {
      if (v instanceof Uint8Array) return v.byteLength + 4;
      if (Array.isArray(v)) return v.reduce((n: number, x) => n + estimateSize(x), 2);
      let n = 2;
      for (const [k, x] of Object.entries(v as object)) n += k.length + 2 + estimateSize(x);
      return n;
    }
    default:
      return 8;
  }
}

function inRange(k: string | number, r?: Range): boolean {
  if (!r) return true;
  if (r.gte !== undefined && k < r.gte) return false;
  if (r.lt !== undefined && k >= r.lt) return false;
  return true;
}

export interface MemoryStorageOptions {
  /** Approximate cap on stored bytes. Commits beyond it fail with StorageQuotaError. */
  quotaBytes?: number;
}

class MemoryStorage implements StorageAdapter {
  private data = new Map<StoreName, Map<string, unknown>>();
  private size = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: MemoryStorageOptions) {}

  private store(name: StoreName): Map<string, unknown> {
    let m = this.data.get(name);
    if (!m) this.data.set(name, (m = new Map()));
    return m;
  }

  transaction<R>(_stores: readonly StoreName[], mode: 'readonly' | 'readwrite', fn: (tx: StorageTx) => Promise<R>): Promise<R> {
    const run = async (): Promise<R> => {
      const overlay = new Map<StoreName, Map<string, unknown | typeof DELETED>>();
      const ov = (s: StoreName) => {
        let m = overlay.get(s);
        if (!m) overlay.set(s, (m = new Map()));
        return m;
      };
      const readEntry = (s: StoreName, key: string): unknown => {
        const o = overlay.get(s)?.get(key);
        if (o !== undefined) return o === DELETED ? undefined : o;
        return this.store(s).get(key);
      };
      const writable = () => {
        if (mode === 'readonly') throw new Error('write in a readonly transaction');
      };
      const tx: StorageTx = {
        get: async <T>(s: StoreName, key: string) => {
          const v = readEntry(s, key);
          return v === undefined ? undefined : (structuredClone(v) as T);
        },
        put: async (s, key, value) => {
          writable();
          ov(s).set(key, structuredClone(value));
        },
        delete: async (s, key) => {
          writable();
          ov(s).set(key, DELETED);
        },
        scan: <T>(s: StoreName, o?: { index?: IndexName; range?: Range; limit?: number }) => {
          const base = this.store(s);
          return (async function* () {
            const merged = new Map<string, unknown>(base);
            for (const [k, v] of overlay.get(s) ?? []) {
              if (v === DELETED) merged.delete(k);
              else merged.set(k, v);
            }
            let rows: { sortKey: string | number; key: string; value: unknown }[] = [];
            for (const [key, value] of merged) {
              let sortKey: string | number = key;
              if (o?.index) {
                const f = (value as Record<string, unknown> | null)?.[INDEX_FIELD[o.index]];
                if (typeof f !== 'string' && typeof f !== 'number') continue;
                sortKey = f;
              }
              if (!inRange(sortKey, o?.range)) continue;
              rows.push({ sortKey, key, value });
            }
            rows.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
            if (o?.limit !== undefined) rows = rows.slice(0, o.limit);
            for (const r of rows) yield { key: r.key, value: structuredClone(r.value) as T };
          })();
        },
      };

      const result = await fn(tx);

      if (mode === 'readwrite') {
        let delta = 0;
        for (const [s, m] of overlay) {
          for (const [k, v] of m) {
            const old = this.store(s).get(k);
            if (old !== undefined) delta -= estimateSize(old) + k.length;
            if (v !== DELETED) delta += estimateSize(v) + k.length;
          }
        }
        if (this.opts.quotaBytes !== undefined && delta > 0 && this.size + delta > this.opts.quotaBytes) {
          throw new StorageQuotaError();
        }
        for (const [s, m] of overlay) {
          for (const [k, v] of m) {
            if (v === DELETED) this.store(s).delete(k);
            else this.store(s).set(k, v);
          }
        }
        this.size += delta;
      }
      return result;
    };
    // Transactions run one at a time, in call order.
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => undefined);
    return next;
  }

  async estimate() {
    return { usageBytes: this.size, quotaBytes: this.opts.quotaBytes ?? Number.MAX_SAFE_INTEGER };
  }

  async persist() {
    return true;
  }

  async close() {
    await this.tail;
  }
}

export function createMemoryStorage(opts: MemoryStorageOptions = {}): StorageAdapter {
  return new MemoryStorage(opts);
}
