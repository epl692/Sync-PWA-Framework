/**
 * Hub core (`@sync/hub-core`): shared TypeScript for the Android and desktop Hubs. Hosts a RelayHub with persistence, access
 * control, retention, and the Bluetooth link server. Contracts it depends on: ./bluetooth-link.md, ./hub-access.md,
 * ./hub-ble-bridge.md. Every `HubStore` implementation MUST pass `hubStoreContract()`.
 */

import type { BleBridge } from './hub-ble-bridge'; // see hub-ble-bridge.md for the full interface

export type SpaceId = string;
export type DeviceId = string;
export type PacketId = string;

export interface HubSettings {
  displayName: string;
  accessMode: 'open' | 'approval';        // default 'open' (spec FR-015)
  autoSpaces: boolean;                    // default false
  maxClients: number;                     // default min(7, platform limit)
  retentionDays: number;                  // default 14
  storageLimitBytes: number;              // default 1 GiB
  perSpaceCapBytes: number;
  hubToHub: boolean;                      // default true when any link code is held
  keepAwake: boolean;
}

export interface ServedSpaceInfo {
  space: SpaceId;
  name?: string;
  source: 'code' | 'auto';
  epochs: number[];
  link: boolean;                          // true when a link code (access secret) is held
  bytesStored: number;
  addedAt: number;
}

export interface ClientInfo {
  device: DeviceId;
  name: string;
  state: 'pending' | 'trusted' | 'blocked';
  connected: boolean;
  spaces: SpaceId[];
  lastSeen: number;
}

export type HubEvent =
  | { type: 'client-connected'; client: ClientInfo }
  | { type: 'client-disconnected'; device: DeviceId }
  | { type: 'approval-needed'; client: ClientInfo }
  | { type: 'space-added'; space: ServedSpaceInfo; auto: boolean }
  | { type: 'storage-warning'; level: 'near-limit' | 'evicting-undelivered'; bytes: number }
  | { type: 'bridge-state'; state: 'ready' | 'bluetooth-off' | 'permission-denied' | 'advertising-failed' | 'unsupported'; detail?: string }
  | { type: 'hub-linked'; fingerprint: string; spaces: SpaceId[] };

/** Owner-facing control surface used by `@sync/hub-ui` (Web Components) and by tests. */
export interface HubControl {
  readonly fingerprint: string;
  settings(): HubSettings;
  updateSettings(patch: Partial<HubSettings>): Promise<void>;

  addServeCode(code: string): Promise<ServedSpaceInfo>;      // validates per hub-access.md
  removeSpace(space: SpaceId, opts: { deleteStored: boolean }): Promise<void>;
  spaces(): ServedSpaceInfo[];

  clients(): ClientInfo[];
  approve(device: DeviceId): Promise<void>;
  deny(device: DeviceId): Promise<void>;
  block(device: DeviceId): Promise<void>;
  unblock(device: DeviceId): Promise<void>;
  disconnect(device: DeviceId): Promise<void>;

  storage(): Promise<{ usedBytes: number; limitBytes: number; perSpace: Record<SpaceId, number>; oldestPacketAt?: number }>;
  on(handler: (e: HubEvent) => void): () => void;
}

export interface HubOptions {
  bridge: BleBridge;
  store: HubStore;
  blobDir?: string;                       // BlobRelay storage root (spec 004); omitted = blobs off
  settings?: Partial<HubSettings>;
  clock?: () => number;
  random?: (n: number) => Uint8Array;
}

export interface Hub extends HubControl {
  start(): Promise<void>;
  stop(): Promise<void>;
}
export declare function createHub(opts: HubOptions): Promise<Hub>;

/**
 * Persistence (research R-10). Stores packets exactly as received; never re-encodes.
 * MUST be crash-safe: a torn last record is discarded on open, earlier records are intact.
 */
export interface HubStore {
  open(): Promise<void>;
  close(): Promise<void>;

  hubKey(): Promise<{ publicKey: Uint8Array; sign(msg: Uint8Array): Promise<Uint8Array> }>;
  settings(): Promise<HubSettings | undefined>;
  saveSettings(s: HubSettings): Promise<void>;

  spaces(): Promise<Array<ServedSpaceRecord>>;
  putSpace(r: ServedSpaceRecord): Promise<void>;
  deleteSpace(space: SpaceId): Promise<void>;

  clients(): Promise<ClientRecord[]>;
  putClient(r: ClientRecord): Promise<void>;

  /** Idempotent by id. Returns false if already held. */
  addPacket(space: SpaceId, id: PacketId, bytes: Uint8Array, receivedAt: number): Promise<boolean>;
  getPackets(space: SpaceId, ids: PacketId[]): Promise<Array<{ id: PacketId; bytes: Uint8Array }>>;
  /** Iterate ids and sizes for building summaries. */
  listIds(space: SpaceId): AsyncIterable<{ id: PacketId; size: number; receivedAt: number; delivered: number }>;
  markDelivered(space: SpaceId, ids: PacketId[]): Promise<void>;

  usage(): Promise<{ total: number; perSpace: Record<SpaceId, number> }>;
  /** Delete expired day shards, then evict by policy until under `limit`. Returns what was dropped. */
  enforce(args: { now: number; retentionDays: number; limitBytes: number }): Promise<{
    expired: number;
    evictedDelivered: number;
    evictedUndelivered: number;
  }>;
}

export interface ServedSpaceRecord {
  space: SpaceId;
  name?: string;
  source: 'code' | 'auto';
  accessKeys: Array<{ epoch: number; publicKey: Uint8Array; addedAt: number; expiresAt?: number }>;
  accessSecret?: Uint8Array;
  addedAt: number;
}

export interface ClientRecord {
  device: DeviceId;
  name: string;
  state: 'pending' | 'trusted' | 'blocked';
  strikes: number;
  blockedUntil?: number;
  lastSeen: number;
  spaces: SpaceId[];
}
