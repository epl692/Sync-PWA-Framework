/**
 * The only file that touches the browser's Bluetooth API. Everything else sees the small structural surface below, so tests
 * inject the `MemoryBleLink` simulator and the rest of the transport never learns whether it is on a real radio.
 */

import { LINK_UUIDS } from './link/uuids';

export interface CharLike extends EventTarget {
  value?: DataView | null;
  readValue?(): Promise<DataView>;
  writeValueWithoutResponse?(v: BufferSource): Promise<void>;
  writeValueWithResponse?(v: BufferSource): Promise<void>;
  writeValue?(v: BufferSource): Promise<void>;
  startNotifications(): Promise<unknown>;
  stopNotifications?(): Promise<unknown>;
}
export interface ServiceLike {
  getCharacteristic(uuid: string): Promise<CharLike>;
}
export interface ServerLike {
  getPrimaryService(uuid: string): Promise<ServiceLike>;
}
export interface GattLike {
  readonly connected: boolean;
  connect(): Promise<ServerLike>;
  disconnect(): void;
}
export interface DeviceLike extends EventTarget {
  readonly id: string;
  readonly name?: string | undefined;
  readonly gatt?: GattLike | undefined;
  watchAdvertisements?(): Promise<void>;
  forget?(): Promise<void>;
}
export interface BluetoothLike {
  requestDevice(opts: unknown): Promise<DeviceLike>;
  getDevices?(): Promise<DeviceLike[]>;
  getAvailability?(): Promise<boolean>;
}

/** The browser's Bluetooth object, or undefined where there is none (Safari, Firefox, Node). */
export function defaultBluetooth(): BluetoothLike | undefined {
  const nav = (globalThis as { navigator?: { bluetooth?: BluetoothLike } }).navigator;
  return nav?.bluetooth;
}

export class GattError extends Error {
  constructor(
    readonly code: 'no-hub' | 'cancelled' | 'connect-failed' | 'no-service' | 'adapter-off' | 'denied',
    message: string,
  ) {
    super(message);
  }
}

/** Show the chooser (needs a user gesture) filtered to Hubs. */
export async function requestHub(bt: BluetoothLike): Promise<DeviceLike> {
  try {
    return await bt.requestDevice({ filters: [{ services: [LINK_UUIDS.serviceUuid] }] });
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name === 'NotFoundError') throw new GattError('cancelled', 'No Hub was chosen or found nearby.');
    if (name === 'SecurityError' || name === 'NotAllowedError') throw new GattError('denied', 'Bluetooth is blocked for this page.');
    throw new GattError('no-hub', (e as Error).message || 'Could not look for Hubs.');
  }
}

/** One open GATT connection to a Hub: INFO read, serialized writes, notification frames, and disconnect. */
export interface GattLink {
  readonly id: string;
  readonly name: string;
  info(): Promise<Uint8Array>;
  /** One frame to `TX`. Writes are serialized, because Web Bluetooth allows only one GATT operation at a time. */
  write(frame: Uint8Array): Promise<void>;
  onFrame(cb: (frame: Uint8Array) => void): void;
  onDisconnect(cb: () => void): void;
  close(): void;
}

const copy = (v: DataView): Uint8Array => new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));

export async function openGattLink(device: DeviceLike): Promise<GattLink> {
  if (!device.gatt) throw new GattError('connect-failed', 'This device has no GATT server.');
  let server: ServerLike;
  try {
    server = await device.gatt.connect();
  } catch (e) {
    throw new GattError('connect-failed', (e as Error).message || 'Could not connect to the Hub.');
  }
  let infoC: CharLike;
  let tx: CharLike;
  let rx: CharLike;
  try {
    const svc = await server.getPrimaryService(LINK_UUIDS.serviceUuid);
    [infoC, tx, rx] = await Promise.all([svc.getCharacteristic(LINK_UUIDS.infoUuid), svc.getCharacteristic(LINK_UUIDS.txUuid), svc.getCharacteristic(LINK_UUIDS.rxUuid)]);
  } catch (e) {
    device.gatt.disconnect();
    throw new GattError('no-service', (e as Error).message || 'This device is not a Hub.');
  }
  const frameCbs: Array<(f: Uint8Array) => void> = [];
  const dropCbs: Array<() => void> = [];
  rx.addEventListener('characteristicvaluechanged', (ev) => {
    const v = (ev.target as CharLike | null)?.value;
    if (v) {
      const b = copy(v);
      for (const cb of frameCbs) cb(b);
    }
  });
  device.addEventListener('gattserverdisconnected', () => {
    for (const cb of dropCbs) cb();
  });
  await rx.startNotifications();

  let chain: Promise<void> = Promise.resolve();
  const rawWrite = async (frame: Uint8Array): Promise<void> => {
    const v = frame as unknown as BufferSource;
    if (tx.writeValueWithoutResponse) {
      try {
        return await tx.writeValueWithoutResponse(v);
      } catch (e) {
        if ((e as { name?: string }).name !== 'NotSupportedError') throw e;
      }
    }
    const slow = tx.writeValueWithResponse ?? tx.writeValue;
    if (!slow) throw new Error('TX cannot be written');
    return slow.call(tx, v);
  };

  return {
    id: device.id,
    name: device.name ?? 'Hub',
    async info() {
      if (!infoC.readValue) throw new Error('INFO cannot be read');
      return copy(await infoC.readValue());
    },
    write(frame) {
      const run = chain.then(() => rawWrite(frame));
      chain = run.catch(() => undefined);
      return run;
    },
    onFrame: (cb) => void frameCbs.push(cb),
    onDisconnect: (cb) => void dropCbs.push(cb),
    close() {
      try {
        device.gatt?.disconnect();
      } catch {
        /* already gone */
      }
    },
  };
}
