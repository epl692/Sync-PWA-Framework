import type { ClientRecord, DeviceId, HubSettings, PacketId, ServedSpaceRecord, SpaceId } from '../types';

/**
 * Persistence for a Hub (research R-10). Packets are stored exactly as received; never re-encoded.
 * Implementations MUST pass `hubStoreContract()` and MUST be crash-safe: a torn last record is discarded on open,
 * earlier records are intact.
 */
export interface HubStore {
  open(): Promise<void>;
  close(): Promise<void>;

  /** The 32-byte Ed25519 seed of the Hub key, if one was saved. Platform shells MAY wrap this with a keystore. */
  loadHubKey(): Promise<Uint8Array | undefined>;
  saveHubKey(seed: Uint8Array): Promise<void>;

  settings(): Promise<HubSettings | undefined>;
  saveSettings(s: HubSettings): Promise<void>;

  spaces(): Promise<ServedSpaceRecord[]>;
  putSpace(r: ServedSpaceRecord): Promise<void>;
  deleteSpace(space: SpaceId): Promise<void>;

  clients(): Promise<ClientRecord[]>;
  putClient(r: ClientRecord): Promise<void>;
  deleteClient(device: DeviceId): Promise<void>;

  /** Idempotent by id. Returns false if already held. */
  addPacket(space: SpaceId, id: PacketId, bytes: Uint8Array, receivedAt: number): Promise<boolean>;
  getPackets(space: SpaceId, ids: PacketId[]): Promise<Array<{ id: PacketId; bytes: Uint8Array }>>;
  /** Ids with sizes, for building summaries and for eviction. */
  listIds(space: SpaceId): AsyncIterable<{ id: PacketId; size: number; receivedAt: number; delivered: number }>;
  markDelivered(space: SpaceId, ids: PacketId[]): Promise<void>;
  /** Remove every packet of a Space (the owner removed it). */
  deleteSpacePackets(space: SpaceId): Promise<void>;

  usage(): Promise<{ total: number; perSpace: Record<SpaceId, number> }>;
  /** Delete expired day shards, then evict by policy until under `limitBytes`. Reports what was dropped. */
  enforce(args: { now: number; retentionDays: number; limitBytes: number }): Promise<EnforceResult>;
}

export interface EnforceResult {
  expired: number;
  evictedDelivered: number;
  evictedUndelivered: number;
  /** Every packet that was removed, so the caller can forget its bytes too. */
  dropped: Array<{ space: SpaceId; id: PacketId }>;
}
