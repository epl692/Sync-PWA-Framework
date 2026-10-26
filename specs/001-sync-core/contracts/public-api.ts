/**
 * App-facing API of @sync/core. Modules (spec 003) program against this.
 * All calls go to the local store; none wait on a transport.
 */

import type { Transport } from './transport';
import type { StorageAdapter } from './storage';
import type { ExtensionRegistry } from './extension-points';

export type ObjectId = string;
export type SpaceId = string;
export type DeviceId = string;
export type JSONValue = null | boolean | number | string | JSONValue[] | { [k: string]: JSONValue };

/** Marker to remove a field in an update. */
export const UNSET = { $unset: true } as const;

export interface DataPacketEnvelope {
  v: number;
  id: string;
  author: DeviceId;
  seq: number;
  space: SpaceId;
  clock: string;
  codec: string;
  body: Uint8Array;
  sig: Uint8Array | null;
}

export interface PacketBody {
  obj: ObjectId;
  op: 'create' | 'update' | 'delete';
  type: string;
  schemaVersion: number;
  fields: Record<string, JSONValue>;
}

export interface SyncableObject {
  id: ObjectId;
  type: string;
  space: SpaceId;
  schemaVersion: number;
  /** Plain values for app use. */
  fields: Record<string, JSONValue>;
  /** Spec 003 C-2: serialized HLC of the last write per field name. Present only when requested with `withClocks`. */
  clocks?: Record<string, string>;
}

export interface Query<T = SyncableObject> {
  /** Emits the current result immediately, then after each change that affects it. */
  subscribe(cb: (result: T[]) => void): () => void;
  /** One-shot read. */
  once(): Promise<T[]>;
  [Symbol.asyncIterator](): AsyncIterator<T[]>;
}

export interface QuerySpec {
  space?: SpaceId;
  type?: string;
  id?: ObjectId;
  /** Predicate over plain fields. Evaluated locally. */
  where?: (obj: SyncableObject) => boolean;
  /** Spec 003 C-2: include per-field clocks in results. Default false. */
  withClocks?: boolean;
}

export interface Config {
  storage: StorageAdapter;
  deviceId?: DeviceId;
  retentionWindowMs?: number; // default 30 days
  maxDriftMs?: number;        // default 5 minutes
  relay?: boolean | Record<SpaceId, boolean>; // default true
  batch?: { packets?: number; bytes?: number };
  confirmThreshold?: number;  // default 1
  limits?: {
    maxEnvelopeBytes?: number;   // default 256 KiB
    maxFieldsPerPacket?: number; // default 256
    maxMessageBytes?: number;    // default 4 MiB
    seqGapWarn?: number;         // default 1,000,000
    maxParkedPerAuthor?: number; // default 1000 (spec 002 A-7): excess parked packets are not stored or counted as held
  };
  now?: () => number;         // injectable for tests
}

export type CoreEvent =
  | { kind: 'storage:pressure'; usageBytes: number; quotaBytes: number }
  | { kind: 'packet:rejected'; id: string; reason: string }
  | { kind: 'packet:parked'; id: string; reason: string }
  | { kind: 'sync:progress'; peer: string; space: SpaceId; received: number; total?: number }
  | { kind: 'transport:state'; transport: string; state: string };

export interface SyncCore extends ExtensionRegistry {
  // ---- objects (every call authors a packet) ----
  create(space: SpaceId, type: string, fields: Record<string, JSONValue>, opts?: { schemaVersion?: number; id?: ObjectId }): Promise<SyncableObject>;
  update(id: ObjectId, fields: Record<string, JSONValue | typeof UNSET>): Promise<SyncableObject>;
  remove(id: ObjectId): Promise<void>;
  get(id: ObjectId, opts?: { withClocks?: boolean }): Promise<SyncableObject | undefined>;

  // ---- reactive queries (FR-003) ----
  query(spec: QuerySpec): Query;

  // ---- transports (FR-014) ----
  addTransport(t: Transport): void;
  removeTransport(id: string): Promise<void>;
  transports(): ReadonlyArray<{ id: string; state: string }>;

  // ---- history (FR-018, FR-019) ----
  /** Undo this device's most recent change to the object within the retention window, via a new compensating packet. Rejects with NotUndoable if not possible (e.g. undo of a delete on a type that does not resurrect). */
  undo(id: ObjectId): Promise<void>;
  history(id: ObjectId): Promise<ReadonlyArray<{ packetId: string; clock: string; op: string; fields: string[] }>>;
  compact(opts?: { space?: SpaceId; olderThanMs?: number }): Promise<{ packetsRemoved: number; bytesFreed?: number }>;

  // ---- added by spec 003 ----
  /** C-1: declare type-level behavior after the core is open. Idempotent; re-evaluates live queries. `$` types throw. */
  registerType(type: string, opts: { resurrects?: boolean }): void;
  unregisterType(type: string): void;

  // ---- added by spec 002 ----
  /** A-2: replay every retained packet of a Space through the validators. Returns how many changed status. */
  rebuildSpace(space: SpaceId): Promise<{ reapplied: number; rejected: number }>;
  /** A-4: plugin message channel; never stored by the core. */
  channel(name: string): { send(peerKey: string, payload: Uint8Array, opts?: { space?: string }): Promise<void>; broadcast(payload: Uint8Array, opts?: { space?: string }): Promise<number>; onMessage(h: (peerKey: string, payload: Uint8Array) => void): () => void; setRoutes(spaces: string[]): void };
  peers(): Array<{ key: string; transport: string; peerId: string; label?: string }>;

  // ---- introspection ----
  /** Canonical hash of the visible and tombstoned state of a Space. Used by convergence tests. */
  stateHash(space: SpaceId): Promise<string>;
  on(cb: (e: CoreEvent) => void): () => void;
  close(): Promise<void>;
}

export declare function createSyncCore(config: Config): Promise<SyncCore>;
