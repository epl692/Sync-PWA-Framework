# Contract: BleBridge (native Bluetooth boundary of the Hub)

The Hub core (TypeScript) never touches a radio. It talks to a `BleBridge`, implemented once per platform shell. Every implementation MUST pass `bleBridgeContract()` from `@sync/testkit` (Principle VIII). Rationale: [research.md](../research.md) R-09.

Implementations: Android (Kotlin Capacitor plugin), macOS (Swift sidecar), Windows (WinRT sidecar), Linux (BlueZ over D-Bus in Node). Sidecars speak the JSON-lines form at the end of this document over stdio.

```ts
export type BleConnId = string;

export interface BleSupport {
  peripheral: { ok: true; maxConnections?: number } | { ok: false; reason: string; code: BleUnsupportedCode };
  central:    { ok: true } | { ok: false; reason: string; code: BleUnsupportedCode };
}
export type BleUnsupportedCode =
  | 'no-adapter' | 'bluetooth-off' | 'permission-denied' | 'peripheral-role-unsupported'
  | 'os-too-old' | 'bridge-failed';

export interface BleBridgeEvents {
  /** A central (client or another Hub) connected to our GATT server. */
  connected(conn: BleConnId, info: { mtu: number }): void;
  /** MTU changed after connect (Android and BlueZ report this). */
  mtu(conn: BleConnId, mtu: number): void;
  /** Bytes the central wrote to TX. One event per GATT write, unmerged and unsplit. */
  write(conn: BleConnId, frame: Uint8Array): void;
  disconnected(conn: BleConnId, reason?: string): void;
  /** Adapter powered off, permission revoked, or advertising stopped by the OS. */
  state(s: 'ready' | 'bluetooth-off' | 'permission-denied' | 'advertising-failed'): void;
  /** Central role only: another Hub seen while scanning. */
  seen(device: { address: string; name?: string; rssi?: number }): void;
  /** Central role only: notification from a Hub we connected to. */
  notify(conn: BleConnId, frame: Uint8Array): void;
}

export interface BleBridge {
  support(): Promise<BleSupport>;

  // Peripheral (serves clients and other Hubs)
  startAdvertising(opts: {
    serviceUuid: string; infoUuid: string; txUuid: string; rxUuid: string;
    name: string; info: Uint8Array; maxConnections: number;
  }): Promise<void>;
  /** Update the INFO characteristic value (slots, mode, full). */
  setInfo(info: Uint8Array): Promise<void>;
  stopAdvertising(): Promise<void>;
  /** Send one notification frame. Rejects if the connection is gone. Resolves when queued. */
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
```

## Required behavior (tested by `bleBridgeContract()`)

1. `support()` never throws; it returns a coded reason. The Windows bridge uses `BluetoothAdapter.IsPeripheralRoleSupported`; other bridges report adapter state.
2. `write` events preserve GATT write boundaries and order per connection. A bridge MUST NOT coalesce or split frames.
3. `notify` preserves order, never exceeds `mtu - 3` bytes (rejects with `frame-too-large` otherwise), and provides backpressure by not resolving until the OS accepted it.
4. When more connections than `maxConnections` arrive, the bridge accepts up to the limit and the core answers the rest with `busy` over a short-lived accepted connection; a bridge that cannot accept even that rejects at the radio level.
5. `disconnected` is emitted exactly once per connection, including on adapter power off.
6. After Bluetooth turns off and on, the bridge re-advertises by itself and emits `state('ready')`.
7. `setInfo` takes effect for the next INFO read; reads never block on the core.
8. `close()` releases the radio and all sockets.

## Platform notes

| Platform | Peripheral | Central | Notes |
|---|---|---|---|
| Android 8+ | `BluetoothGattServer`, `BluetoothLeAdvertiser` | `BluetoothGatt` | Needs `BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT`, `BLUETOOTH_SCAN` runtime permissions on 12+, foreground service for background. Typical limit about 7 connections |
| macOS 12+ | `CBPeripheralManager` | `CBCentralManager` | Bluetooth permission prompt; advertising name is truncated by the OS |
| Windows 10 1703+ | `GattServiceProvider` | `BluetoothLEAdvertisementWatcher` + `BluetoothLEDevice` | Peripheral role needs a supporting radio (check `IsPeripheralRoleSupported`); report `peripheral-role-unsupported` otherwise |
| Linux (BlueZ 5.50+) | `org.bluez.GattManager1`, `LEAdvertisingManager1` | `org.bluez.Device1` | Needs BlueZ with experimental features off; advertising instance limits vary by controller |

## JSON-lines sidecar protocol (desktop)

One JSON object per line, UTF-8, over stdin/stdout. Binary values are base64. The Hub core sends `{id, op, ...args}`; the sidecar replies `{id, ok: true, ...}` or `{id, ok: false, code, message}`, and emits unsolicited `{event, ...}` lines matching `BleBridgeEvents`. Operations mirror the methods above (`support`, `startAdvertising`, `setInfo`, `stopAdvertising`, `notify`, `disconnect`, `startScan`, `stopScan`, `connect`, `write`, `close`). The sidecar exits when stdin closes. Lines longer than 8 KiB are a protocol error. The first line a sidecar writes is `{event:"hello", bridge:"windows|macos", version:1}`; the core refuses a version it does not know.

## Compatibility

A bridge declares `version` (sidecar) or a plugin API version (Android). The core supports the current and previous version. Additive operations are allowed; removing or changing one bumps the version.
