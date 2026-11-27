/** Shared Hub types (specs/005-bluetooth-transport/contracts/hub-core.ts, data-model.md). */

export type SpaceId = string;
export type DeviceId = string;
export type PacketId = string;

export interface HubSettings {
  displayName: string;
  accessMode: 'open' | 'approval';
  autoSpaces: boolean;
  maxClients: number;
  retentionDays: number;
  storageLimitBytes: number;
  perSpaceCapBytes: number;
  hubToHub: boolean;
  keepAwake: boolean;
}

export interface ServedSpaceInfo {
  space: SpaceId;
  name?: string;
  source: 'code' | 'auto';
  epochs: number[];
  /** True when a link code (access secret) is held for this Space. */
  link: boolean;
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
  | {
      type: 'bridge-state';
      state: 'ready' | 'bluetooth-off' | 'permission-denied' | 'advertising-failed' | 'unsupported';
      detail?: string;
    }
  | { type: 'hub-linked'; fingerprint: string; spaces: SpaceId[] };

export interface AccessKeyRecord {
  epoch: number;
  publicKey: Uint8Array;
  addedAt: number;
  expiresAt?: number;
}

export interface ServedSpaceRecord {
  space: SpaceId;
  name?: string;
  source: 'code' | 'auto';
  accessKeys: AccessKeyRecord[];
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

/** Owner-facing control surface used by `@sync/hub-ui` and by tests. */
export interface HubControl {
  readonly fingerprint: string;
  settings(): HubSettings;
  updateSettings(patch: Partial<HubSettings>): Promise<void>;

  addServeCode(code: string): Promise<ServedSpaceInfo>;
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
