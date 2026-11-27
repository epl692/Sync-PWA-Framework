/**
 * BleBridge: the native Bluetooth boundary of the Hub (specs/005-bluetooth-transport/contracts/hub-ble-bridge.md).
 * The Hub core never touches a radio; every implementation passes the shared `bleBridgeContract()` suite.
 */

export type BleConnId = string;

export type BleUnsupportedCode =
  | 'no-adapter'
  | 'bluetooth-off'
  | 'permission-denied'
  | 'peripheral-role-unsupported'
  | 'os-too-old'
  | 'bridge-failed';

export interface BleSupport {
  peripheral: { ok: true; maxConnections?: number } | { ok: false; reason: string; code: BleUnsupportedCode };
  central: { ok: true } | { ok: false; reason: string; code: BleUnsupportedCode };
}

export interface BleBridgeEvents {
  /** A central (client or another Hub) connected to our GATT server. */
  connected(conn: BleConnId, info: { mtu: number }): void;
  /** MTU changed after connect. */
  mtu(conn: BleConnId, mtu: number): void;
  /** Bytes the central wrote to TX. One event per GATT write, unmerged and unsplit. */
  write(conn: BleConnId, frame: Uint8Array): void;
  disconnected(conn: BleConnId, reason?: string): void;
  state(s: 'ready' | 'bluetooth-off' | 'permission-denied' | 'advertising-failed'): void;
  /** Central role only: another Hub seen while scanning. */
  seen(device: { address: string; name?: string; rssi?: number }): void;
  /** Central role only: notification from a Hub we connected to. */
  notify(conn: BleConnId, frame: Uint8Array): void;
}

export interface AdvertisingOptions {
  serviceUuid: string;
  infoUuid: string;
  txUuid: string;
  rxUuid: string;
  name: string;
  info: Uint8Array;
  maxConnections: number;
}

export class BleError extends Error {
  constructor(
    readonly code: 'frame-too-large' | 'not-connected' | 'unsupported' | 'bridge-failed',
    message?: string,
  ) {
    super(message ?? code);
  }
}

export interface BleBridge {
  support(): Promise<BleSupport>;

  // Peripheral (serves clients and other Hubs)
  startAdvertising(opts: AdvertisingOptions): Promise<void>;
  /** Update the INFO characteristic value (slots, mode, full). */
  setInfo(info: Uint8Array): Promise<void>;
  stopAdvertising(): Promise<void>;
  /** Send one notification frame. Rejects (`BleError`) if the connection is gone or the frame exceeds `mtu - 3`. */
  notify(conn: BleConnId, frame: Uint8Array): Promise<void>;
  disconnect(conn: BleConnId): Promise<void>;

  // Central (Hub-to-Hub)
  startScan(serviceUuid: string): Promise<void>;
  stopScan(): Promise<void>;
  connect(address: string): Promise<{ conn: BleConnId; mtu: number; info: Uint8Array }>;
  /** Write one frame (write without response). */
  write(conn: BleConnId, frame: Uint8Array): Promise<void>;

  on<K extends keyof BleBridgeEvents>(event: K, handler: BleBridgeEvents[K]): () => void;
  close(): Promise<void>;
}
