/** StorageAdapter contract (specs/001-sync-core/contracts/storage.ts). */

export type StoreName = 'objects' | 'packets' | 'outbox' | 'summary' | 'snapshots' | 'meta';
export const STORE_NAMES: readonly StoreName[] = ['objects', 'packets', 'outbox', 'summary', 'snapshots', 'meta'];

export interface Range {
  /** Inclusive lower bound. */
  gte?: string | number;
  /** Exclusive upper bound. */
  lt?: string | number;
}

export type IndexName = 'bySpace' | 'byClock' | 'byAuthor';

/** Indexes read the `space`, `clock` and `author` properties of stored values. */
export const INDEX_FIELD: Record<IndexName, string> = { bySpace: 'space', byClock: 'clock', byAuthor: 'author' };

export interface StorageTx {
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  put<T>(store: StoreName, key: string, value: T): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
  scan<T>(
    store: StoreName,
    opts?: { index?: IndexName; range?: Range; limit?: number },
  ): AsyncIterable<{ key: string; value: T }>;
}

export interface StorageAdapter {
  /**
   * Run `fn` atomically across stores. If it throws, no writes are visible.
   * Quota problems surface as StorageQuotaError and leave state unchanged.
   */
  transaction<R>(
    stores: readonly StoreName[],
    mode: 'readonly' | 'readwrite',
    fn: (tx: StorageTx) => Promise<R>,
  ): Promise<R>;
  estimate?(): Promise<{ usageBytes: number; quotaBytes: number } | undefined>;
  persist?(): Promise<boolean>;
  close(): Promise<void>;
}

export class StorageQuotaError extends Error {
  readonly code = 'storage-quota';
  constructor(message = 'Storage quota exceeded') {
    super(message);
    this.name = 'StorageQuotaError';
  }
}
