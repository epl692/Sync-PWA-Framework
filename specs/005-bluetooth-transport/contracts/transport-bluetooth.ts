/**
 * Browser-side Bluetooth transport (`@sync/transport-bluetooth`). Implements the 001 `Transport` contract.
 * Every implementation MUST pass `transportContract()` and `laneContract()` from @sync/testkit.
 *
 * The browser acts as the Bluetooth central via Web Bluetooth and connects to Hubs (see contracts/bluetooth-link.md).
 * Each connected Hub is one peer (`PeerInfo.id = "hub:<fingerprint>"`); the core treats the Hub as a relay (wildcard Space,
 * narrowed by the Hub's admission gate).
 */

import type { Transport, TransportFactory, PeerInfo } from '@sync/core';

export type BluetoothTransportStatus =
  | { kind: 'unsupported'; reason: 'no-web-bluetooth' | 'insecure-context' | 'no-bluetooth-adapter'; message: string }
  | { kind: 'unavailable'; reason: 'bluetooth-off' | 'permission-denied' | 'blocked-by-policy'; message: string }
  | { kind: 'needs-hub'; message: string }       // supported, no Hub chosen yet
  | { kind: 'ready' }
  | { kind: 'full'; hub: string; retryAfterMs: number };

export interface HubCandidate {
  /** From INFO; untrusted display data until the handshake pins the key. */
  name: string;
  fingerprint: string;
  mode: 'open' | 'approval';
  slots: number;
}

export interface TrustedHub {
  fingerprint: string;
  name: string;
  autoReconnect: boolean;
  lastConnected?: number;
}

export type HubConnectionState =
  | 'searching' | 'connecting' | 'securing' | 'authenticating' | 'pending'
  | 'syncing' | 'idle' | 'disconnected' | 'full' | 'error';

export interface HubConnectionInfo {
  fingerprint: string;
  name: string;
  state: HubConnectionState;
  /** Spaces the Hub accepted for this session. Never lists Spaces the Hub rejected. */
  acceptedSpaces: string[];
  frameBytes: number;
  pendingOut: number;
  pendingIn: number;
  detail?: string;
}

/** Provided by the Spaces module (spec 002 amendment S-2). The transport never sees keys, only signatures. */
export interface HubProofProvider {
  /** Spaces this device can prove membership for, with their latest epoch. */
  spaces(): Array<{ space: string; epoch: number }>;
  /** Sign the Hub challenge for one Space/epoch with that epoch's derived access key. */
  proveSpace(args: { space: string; epoch: number; challenge: Uint8Array }): Promise<Uint8Array>;
  /** Sign the session binding with the device signing key. */
  proveDevice(args: { challenge: Uint8Array }): Promise<{ device: string; sig: Uint8Array; name: string }>;
  /** Access public keys, only used for the optional automatic-mode claim. */
  accessPublic(space: string, epoch: number): Promise<Uint8Array>;
}

export interface BluetoothTransportOptions {
  proofs: HubProofProvider;
  /** Persists pinned Hubs. Default: IndexedDB database `sync-bluetooth-v1`. */
  trustStore?: TrustedHubStore;
  /** Called on first contact with a Hub; resolve true if the user confirms the shown fingerprint and name. */
  confirmHub(hub: HubCandidate): Promise<boolean>;
  /** Spaces to prove; default all `proofs.spaces()`. */
  spaces?: string[];
  autoReconnect?: boolean;              // default true for trusted Hubs
  /** Blob auto-transfer ceiling advertised to the blob module (research R-05). Default 5 MiB. */
  blobCeilingBytes?: number;
  limits?: { maxMessageBytes?: number; reassemblyTimeoutMs?: number };
  /** Injection points for tests (MemoryBleLink). Default: `navigator.bluetooth`. */
  bluetooth?: BluetoothLike;
}

export interface TrustedHubStore {
  list(): Promise<TrustedHub[]>;
  get(fingerprint: string): Promise<(TrustedHub & { publicKey: Uint8Array }) | undefined>;
  put(h: TrustedHub & { publicKey: Uint8Array }): Promise<void>;
  forget(fingerprint: string): Promise<void>;
}

export interface BluetoothTransport extends Transport {
  readonly id: 'bluetooth';
  status(): BluetoothTransportStatus;
  /**
   * Show the browser's device chooser filtered to Hubs and connect. MUST be called from a user gesture.
   * Resolves when the link is ready (or pending owner approval; `connections()` shows which).
   */
  chooseHub(): Promise<HubConnectionInfo>;
  /** Reconnect to a pinned Hub without the chooser where the browser allows it; otherwise rejects with `needs-gesture`. */
  reconnect(fingerprint: string): Promise<HubConnectionInfo>;
  disconnectHub(fingerprint: string): Promise<void>;
  /** Forget the pin and permission. The next contact asks the user to confirm again. */
  forgetHub(fingerprint: string): Promise<void>;
  trustedHubs(): Promise<TrustedHub[]>;
  setAutoReconnect(fingerprint: string, on: boolean): Promise<void>;
  connections(): HubConnectionInfo[];
  on(event: 'connections', handler: (c: HubConnectionInfo[]) => void): () => void;
  on(event: 'status', handler: (s: BluetoothTransportStatus) => void): () => void;
  on(event: 'identity-changed', handler: (info: { fingerprint: string; name: string }) => void): () => void;
}

export declare const bluetoothTransportFactory: TransportFactory<BluetoothTransportOptions>;

/** Minimal Web Bluetooth surface the transport uses, so tests can inject the simulator. */
export interface BluetoothLike {
  requestDevice(opts: unknown): Promise<unknown>;
  getDevices?(): Promise<unknown[]>;
  getAvailability?(): Promise<boolean>;
}

/**
 * Mapping to the 001 TransportState:
 *  unsupported -> 'unsupported'; unavailable/needs-hub -> 'idle' (with detail); ready -> 'ready';
 *  link steps -> 'connecting'; full -> 'ready' for other Hubs, 'error' only if every known Hub is full.
 * `PeerInfo.label` is the Hub's display name.
 */
export type { PeerInfo };

/** Module registration (spec 003): declares the Spaces it may reach (all the app declares) and no object types. */
export interface BluetoothModuleConfig {
  enabledSpaces?: string[] | 'all';
  options: Omit<BluetoothTransportOptions, 'proofs'>;
}
