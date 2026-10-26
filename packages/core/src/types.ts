/** Public types of @sync/core. Mirrors specs/001-sync-core/contracts/public-api.ts. */

import type { StorageAdapter } from './storage/types';
import type { Transport } from './sync/transport';
import type { CompactionPin, PacketSigner, PacketValidator, PayloadCodec, SnapshotGuard } from './extension/types';
import type { Channel, PeerSummary } from './sync/channel';
import type { Snapshot } from './history/snapshot';

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
  /** Serialized HLC of the last write per field name. Present only when requested with `withClocks` (spec 003 C-2). */
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
  /** Include per-field clocks in the results (spec 003 C-2). Default false. */
  withClocks?: boolean;
}

export interface Limits {
  maxEnvelopeBytes: number;
  maxFieldsPerPacket: number;
  maxMessageBytes: number;
  seqGapWarn: number;
  /** Parked packets kept per (Space, author). Excess packets are not stored or counted as held (A-7). */
  maxParkedPerAuthor: number;
}

export interface Config {
  storage: StorageAdapter;
  deviceId?: DeviceId;
  retentionWindowMs?: number;
  maxDriftMs?: number;
  relay?: boolean | Record<SpaceId, boolean>;
  batch?: { packets?: number; bytes?: number };
  confirmThreshold?: number;
  limits?: Partial<Limits>;
  /** Compact old history in the background (shortly after open, then every 6 hours). Default true. */
  autoCompact?: boolean;
  /** Spaces to sync even before they hold any data (a new device joining a Space). */
  spaces?: SpaceId[];
  now?: () => number;
  /** Optional initial extensions, equivalent to calling registerCodec / registerValidator after create. */
  codecs?: PayloadCodec[];
  validators?: PacketValidator[];
  /** Types whose edits resurrect a deleted object (spec 003 supplies this from schemas). */
  resurrectingTypes?: string[];
}

export interface ResolvedConfig {
  storage: StorageAdapter;
  deviceId?: DeviceId;
  retentionWindowMs: number;
  maxDriftMs: number;
  relay: boolean | Record<SpaceId, boolean>;
  batch: { packets: number; bytes: number };
  confirmThreshold: number;
  limits: Limits;
  spaces: SpaceId[];
  autoCompact: boolean;
  now: () => number;
  resurrectingTypes: Set<string>;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

export function resolveConfig(c: Config): ResolvedConfig {
  return {
    storage: c.storage,
    deviceId: c.deviceId,
    retentionWindowMs: c.retentionWindowMs ?? 30 * DAY_MS,
    maxDriftMs: c.maxDriftMs ?? 5 * 60 * 1000,
    relay: c.relay ?? true,
    batch: { packets: c.batch?.packets ?? 500, bytes: c.batch?.bytes ?? 1024 * 1024 },
    confirmThreshold: c.confirmThreshold ?? 1,
    limits: {
      maxEnvelopeBytes: c.limits?.maxEnvelopeBytes ?? 256 * 1024,
      maxFieldsPerPacket: c.limits?.maxFieldsPerPacket ?? 256,
      maxMessageBytes: c.limits?.maxMessageBytes ?? 4 * 1024 * 1024,
      seqGapWarn: c.limits?.seqGapWarn ?? 1_000_000,
      maxParkedPerAuthor: c.limits?.maxParkedPerAuthor ?? 1000,
    },
    spaces: c.spaces ?? [],
    autoCompact: c.autoCompact ?? true,
    now: c.now ?? (() => Date.now()),
    resurrectingTypes: new Set(c.resurrectingTypes ?? []),
  };
}

export type CoreEvent =
  | { kind: 'storage:pressure'; usageBytes: number; quotaBytes: number }
  | { kind: 'packet:rejected'; id: string; reason: string }
  | { kind: 'packet:parked'; id: string; reason: string }
  | { kind: 'sync:progress'; peer: string; space: SpaceId; received: number; total?: number; warning?: string }
  | { kind: 'transport:state'; transport: string; state: string };

export type IngestResult =
  | { status: 'applied'; id: string }
  | { status: 'duplicate'; id: string }
  | { status: 'parked'; id: string; reason: string }
  | { status: 'rejected'; id?: string; reason: string };

export class NoCodecError extends Error {
  readonly code = 'no-codec';
  constructor() {
    super('No payload codec is registered; refusing to write unencoded data');
    this.name = 'NoCodecError';
  }
}

export class NotUndoableError extends Error {
  readonly code = 'not-undoable';
  constructor(reason: string) {
    super(`Not undoable: ${reason}`);
    this.name = 'NotUndoableError';
  }
}

export class ObjectNotFoundError extends Error {
  readonly code = 'not-found';
  constructor(id: string) {
    super(`Object not found: ${id}`);
    this.name = 'ObjectNotFoundError';
  }
}

export interface ExtensionRegistry {
  registerCodec(codec: PayloadCodec, opts?: { makeDefault?: boolean }): void;
  registerValidator(validator: PacketValidator): void;
  /** A-1: sign locally authored packets. */
  registerSigner(signer: PacketSigner): void;
  /** A-3: seal and authenticate snapshot messages. */
  registerSnapshotGuard(guard: SnapshotGuard): void;
  /** A-6: keep matching objects out of snapshots and out of compaction. */
  registerCompactionPin(pin: CompactionPin): void;
  revalidate(opts?: { space?: string }): Promise<{ applied: number; stillParked: number }>;
}

export interface SyncCore extends ExtensionRegistry {
  readonly deviceId: DeviceId;

  create(
    space: SpaceId,
    type: string,
    fields: Record<string, JSONValue>,
    opts?: { schemaVersion?: number; id?: ObjectId },
  ): Promise<SyncableObject>;
  update(id: ObjectId, fields: Record<string, JSONValue | typeof UNSET>): Promise<SyncableObject>;
  remove(id: ObjectId): Promise<void>;
  get(id: ObjectId, opts?: { withClocks?: boolean }): Promise<SyncableObject | undefined>;

  query(spec: QuerySpec): Query;

  /**
   * Spec 003 C-1: declares type-level behavior after the core is open. Idempotent. Re-evaluates live queries.
   * `$`-prefixed types are reserved and throw.
   */
  registerType(type: string, opts: { resurrects?: boolean }): void;
  unregisterType(type: string): void;

  /** The single path for packets received from any source: decode, validate, merge. */
  ingest(raw: Uint8Array, source: string): Promise<IngestResult>;
  /** Same path for a batch; live queries re-evaluate once at the end. */
  ingestBatch(raws: readonly Uint8Array[], source: string): Promise<IngestResult[]>;

  addTransport(t: Transport): void;
  removeTransport(id: string): Promise<void>;
  transports(): ReadonlyArray<{ id: string; state: string }>;

  undo(id: ObjectId): Promise<void>;
  history(id: ObjectId): Promise<ReadonlyArray<{ packetId: string; clock: string; op: string; fields: string[] }>>;
  compact(opts?: { space?: SpaceId; olderThanMs?: number }): Promise<{ packetsRemoved: number; bytesFreed?: number }>;

  /** The Space's compacted state, if any. Peers bootstrap from it. */
  exportSnapshot(space: SpaceId): Promise<Snapshot | undefined>;
  installSnapshot(snapshot: Snapshot): Promise<void>;

  /**
   * A-2: clear the derived state of a Space and re-run every retained packet through the validators in clock
   * order. Used when authority changed retroactively. Returns how many packets changed status.
   */
  rebuildSpace(space: SpaceId): Promise<{ reapplied: number; rejected: number }>;

  /** A-4: a named message channel for plugins. Messages are never stored by the core. */
  channel(name: string): Channel;
  /** A-8: called synchronously after each packet is applied and committed (including parked packets applied later). */
  onApplied(cb: (e: { env: DataPacketEnvelope; body: PacketBody; source: string }) => void): () => void;
  /** A-8: decoded applied packets of a Space (optionally only bodies whose type starts with a prefix), oldest first. */
  scanApplied(space: SpaceId, opts?: { typePrefix?: string }): Promise<Array<{ env: DataPacketEnvelope; body: PacketBody }>>;
  /** A-8: highest clock and sequence number applied per author in a Space (system objects excluded). */
  authorStats(space: SpaceId): Promise<Record<string, { clock: string; seq: number }>>;
  /** A-8: which packets this device holds for a Space (per author, inclusive seq intervals). */
  held(space: SpaceId): Promise<Record<string, Array<[number, number]>>>;
  /** Which payload codecs are registered, and which one writes. Lets a release build assert it is not running plaintext. */
  codecs(): { default?: string; ids: string[] };
  /** Currently connected peers across all transports. */
  peers(): PeerSummary[];

  stateHash(space: SpaceId): Promise<string>;
  on(cb: (e: CoreEvent) => void): () => void;
  close(): Promise<void>;
}
