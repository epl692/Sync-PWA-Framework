/**
 * Public API of @sync/blobs (spec 004). Wire formats are in blob-format.md and blob-protocol.md;
 * entities and state transitions are in ../data-model.md.
 */

export type SpaceId = string;
export type ObjectId = string;

/** The value stored in an object field. Contains no bytes. */
export interface BlobRef {
  $blob: 1;
  /** base64url SHA-256 of the manifest (43 chars). */
  id: string;
  /** Plaintext bytes. */
  size: number;
  /** Media type, e.g. "image/jpeg". */
  type: string;
  space: SpaceId;
  /** Space ID or override share ID whose epoch key encrypted the blob. */
  scope: string;
  /** 16 hex chars: which epoch key (survives rotation). */
  keyId: string;
  /** Display name only; never used as a path. */
  name?: string;
}

export type BlobState = 'missing' | 'downloading' | 'available' | 'failed';
export type BlobFailure = 'quota' | 'too-large' | 'verification' | 'no-key' | 'cancelled' | 'unavailable';

export interface BlobStatus {
  state: BlobState;
  size: number;
  /** 0..1. 1 when available. */
  progress: number;
  bytesDone: number;
  /** `missing`: 'evicted' | 'no-source' | 'not-requested'. `failed`: see BlobFailure. */
  reason?: 'evicted' | 'no-source' | 'not-requested' | BlobFailure;
  /** Device-local keep flag. */
  pinned: boolean;
  /** Peers/relays that confirmed a full copy (this device's belief). */
  replicas: number;
}

export interface Observable<T> {
  get(): T;
  subscribe(listener: (value: T) => void): () => void;
}

export interface AttachOptions {
  space: SpaceId;
  /** The object the reference will be stored in (may be a freshly allocated ID passed to core.create({id})). Decides the scope. */
  obj: ObjectId;
  /** Overrides File.type / Blob.type. */
  type?: string;
  name?: string;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

export interface OpenOptions {
  /** Start fetching if not local (default true). With false, rejects with BlobNotLocalError when missing. */
  fetch?: boolean;
  signal?: AbortSignal;
}

export interface BlobsConfig {
  /** Largest accepted blob, bytes. Default 1 GiB, maximum 16 GiB. */
  maxBlobBytes?: number;
  /** Local ciphertext budget. Unset = never evict (spec Assumptions). */
  budgetBytes?: number;
  /** A copy counts as safe to evict once this many peers/relays confirmed it. Default 1. */
  minReplicas?: number;
  /** Evict unpinned replicated blobs on a quota error when no budget is set. Default false. */
  evictOnQuota?: boolean;
  /** Delete a blob this long after its last reference disappeared. Default 30 days. */
  retentionMs?: number;
  /** An attached blob never referenced within this time counts as unreferenced. Default 24 h. */
  orphanGraceMs?: number;
  /** Fetch automatically when true for a reference seen in an applied packet. Default: never (on demand only). */
  prefetch?: (ref: BlobRef) => boolean;
  /** Peers asked in parallel for one blob. Default 2. */
  maxSources?: number;
  /** Outstanding chunk messages per peer. Default 8 (32 on bulk transports). */
  window?: number;
  /** Serve chunks to peers. Default true. */
  serve?: boolean;
  now?: () => number;
}

export interface BlobEvents {
  'blob:attached': { ref: BlobRef };
  'blob:progress': { id: string; bytesDone: number; size: number };
  'blob:available': { id: string };
  'blob:failed': { id: string; reason: BlobFailure };
  'blob:evicted': { id: string; bytes: number };
  'blob:deleted': { id: string; reason: 'unreferenced' | 'orphan' };
  'blob:rejected': { id: string; peer: string; reason: string };   // tampered or malformed data from a peer
  'blob:storage': { usedBytes: number; budgetBytes?: number };
}

export interface Blobs {
  /**
   * Encrypt, chunk and store `source` locally, and return the reference to put in a field. Resolves after encryption,
   * not after upload; upload happens later in the background. Works fully offline. Identical content in the same
   * scope and epoch returns the same reference (dedup, FR-007).
   */
  attach(source: Blob, opts: AttachOptions): Promise<BlobRef>;

  /** Current status as an observable (FR-010). Does not start a fetch. */
  observe(ref: BlobRef): Observable<BlobStatus>;

  /** Start (or join) a fetch. Resolves when available, rejects with BlobFetchError on failure or cancel. */
  request(ref: BlobRef, opts?: { priority?: 'high' | 'normal' | 'low'; signal?: AbortSignal }): Promise<void>;

  /** Decrypted bytes as a stream. Verifies each chunk's tag; aborts with BlobIntegrityError on failure. */
  open(ref: BlobRef, opts?: OpenOptions): Promise<ReadableStream<Uint8Array>>;
  /** Convenience: assemble the plaintext in memory (fine for images; avoid for very large files). */
  toBlob(ref: BlobRef, opts?: OpenOptions): Promise<Blob>;

  /** Stop an active fetch; verified chunks are kept for resume. */
  cancel(ref: BlobRef): void;

  /** Device-local keep flags (not synced). */
  pin(ref: BlobRef): Promise<void>;
  unpin(ref: BlobRef): Promise<void>;

  /** Storage report and manual maintenance. */
  usage(): Promise<{ usedBytes: number; blobs: number; pinnedBytes: number; unreplicatedBytes: number }>;
  /** Evict down to the budget now. Returns bytes freed. */
  evict(opts?: { targetBytes?: number }): Promise<number>;
  /** Run reference GC now. Returns blobs deleted. */
  collect(): Promise<number>;
  /** Rebuild the reference index from object state (also done automatically when its version changes). */
  reindex(): Promise<void>;

  on<K extends keyof BlobEvents>(event: K, handler: (e: BlobEvents[K]) => void): () => void;
  /** Stop timers and transfers; stored data is kept. */
  close(): Promise<void>;
}

/** Composition root. `core` and `keys` come from openSecureCore; storage defaults to IndexedDB in browsers. */
export interface CreateBlobsOptions {
  core: unknown; // SyncCore from @sync/core
  keys: unknown; // spaces.blobKeys (S-1)
  storage?: BlobStorage;
  config?: BlobsConfig;
}
export declare function createBlobs(opts: CreateBlobsOptions): Promise<Blobs>;

// ---------------------------------------------------------------------------------------------
// Errors
export declare class BlobFetchError extends Error { readonly reason: BlobFailure }
export declare class BlobIntegrityError extends Error {}
export declare class BlobNotLocalError extends Error {}
export declare class BlobKeyError extends Error {}   // no entitlement to the scope/epoch at attach time

// ---------------------------------------------------------------------------------------------
// Local storage contract. Every implementation MUST pass blobStorageContract() from @sync/testkit.
// Stores ciphertext chunks (`nonce || ct`) and verified manifests only.

export interface StoredBlob {
  id: string;
  manifest: Uint8Array;
  space: SpaceId;
  scope: string;
  keyId: string;
  size: number;
  type: string;
  origin: 'local' | 'remote';
  replicas: string[];
  pinned: boolean;
  createdAt: number;
  lastAccessAt: number;
  unreferencedAt: number | null;
}

export interface BlobStorage {
  getBlob(id: string): Promise<StoredBlob | undefined>;
  /** Create or merge the record (idempotent). Never clears existing chunks. */
  putBlob(rec: StoredBlob): Promise<void>;
  listBlobs(opts?: { orderBy?: 'lastAccessAt' | 'createdAt'; limit?: number }): AsyncIterable<StoredBlob>;
  deleteBlob(id: string): Promise<void>;           // record, chunks and refs

  /** Idempotent. Rejects with StorageQuotaError (from @sync/core) and leaves state unchanged on quota failure. */
  putChunk(id: string, index: number, stored: Uint8Array): Promise<void>;
  getChunk(id: string, index: number): Promise<Uint8Array | undefined>;
  /** Indexes of chunks present, ascending. */
  presentChunks(id: string): Promise<number[]>;
  deleteChunks(id: string): Promise<number>;       // bytes freed; keeps the record (eviction)

  getRefs(id: string): Promise<string[]>;
  setRefs(id: string, objects: string[]): Promise<void>;
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta<T>(key: string, value: T): Promise<void>;

  /** Bytes of chunk data held (cached counter, recomputable). */
  usedBytes(): Promise<number>;
  estimate?(): Promise<{ usageBytes: number; quotaBytes: number } | undefined>;
  close(): Promise<void>;
}
