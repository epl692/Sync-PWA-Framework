/**
 * StorageAdapter contract. IndexedDB is the browser implementation; an
 * in-memory adapter serves tests and Node hubs. Every implementation MUST
 * pass `storageContract()` from @sync/testkit.
 */

export type StoreName = 'objects' | 'packets' | 'outbox' | 'summary' | 'snapshots' | 'meta';

export interface Range {
  /** Inclusive lower bound, exclusive upper bound. Compared as strings or numbers per index. */
  gte?: string | number;
  lt?: string | number;
}

export interface StorageTx {
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  put<T>(store: StoreName, key: string, value: T): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
  /** Scan by primary key order, or by a declared index. */
  scan<T>(
    store: StoreName,
    opts?: { index?: 'bySpace' | 'byClock' | 'byAuthor'; range?: Range; limit?: number },
  ): AsyncIterable<{ key: string; value: T }>;
}

export interface StorageAdapter {
  /**
   * Run `fn` atomically across stores. If it throws, no writes are visible.
   * A QuotaExceededError MUST surface as `StorageQuotaError` and leave state unchanged.
   */
  transaction<R>(
    stores: readonly StoreName[],
    mode: 'readonly' | 'readwrite',
    fn: (tx: StorageTx) => Promise<R>,
  ): Promise<R>;

  estimate?(): Promise<{ usageBytes: number; quotaBytes: number } | undefined>;
  /** Ask the platform not to evict data (navigator.storage.persist). Best effort. */
  persist?(): Promise<boolean>;
  close(): Promise<void>;
}

export class StorageQuotaError extends Error {
  readonly code = 'storage-quota';
}
