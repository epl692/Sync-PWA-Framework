/** A `BleBridge` (spec 005) running on the `MemoryBleLink` simulator. Used by Hub tests; real bridges are tested with the same contract suite. */

import {
  BleError,
  type AdvertisingOptions,
  type BleBridge,
  type BleBridgeEvents,
  type BleConnId,
  type BleSupport,
} from '@sync/hub-core';
import type { MemoryBleLink, PeripheralHandle } from './memoryBleLink';

export interface MockBleBridgeOptions {
  /** Extra connections accepted beyond `maxConnections` so the core can answer `busy` (default 2). */
  busySlots?: number;
  support?: BleSupport;
}

type Handlers = { [K in keyof BleBridgeEvents]: Set<BleBridgeEvents[K]> };

export class MockBleBridge implements BleBridge {
  private readonly h: Handlers = { connected: new Set(), mtu: new Set(), write: new Set(), disconnected: new Set(), state: new Set(), seen: new Set(), notify: new Set() };
  private handle: PeripheralHandle;
  private adv: AdvertisingOptions | undefined;
  private info = new Uint8Array(0);
  private readonly open = new Set<BleConnId>();
  private closed = false;
  private offPower: () => void;

  constructor(
    readonly link: MemoryBleLink,
    private readonly o: MockBleBridgeOptions = {},
  ) {
    this.handle = link.registerPeripheral({
      info: () => this.info.slice(),
      connect: (id, mtu) => {
        const cap = (this.adv?.maxConnections ?? 0) + (this.o.busySlots ?? 2);
        if (this.closed || !this.adv || this.open.size >= cap) return false;
        this.open.add(id);
        queueMicrotask(() => this.emit('connected', id, { mtu }));
        return true;
      },
      write: (id, frame) => {
        if (this.open.has(id)) this.emit('write', id, frame);
      },
      disconnected: (id) => {
        if (!this.open.delete(id)) return;
        this.emit('disconnected', id, undefined);
      },
    });
    this.offPower = link.onPower((on) => {
      if (this.closed) return;
      if (on) {
        this.advertise();
        this.emit('state', 'ready');
      } else {
        this.emit('state', 'bluetooth-off');
      }
    });
  }

  private emit<K extends keyof BleBridgeEvents>(e: K, ...args: Parameters<BleBridgeEvents[K]>): void {
    for (const f of [...this.h[e]]) (f as (...a: unknown[]) => void)(...args);
  }

  private advertise(): void {
    const a = this.adv;
    if (!a) return;
    this.handle.setAdvertising({ serviceUuid: a.serviceUuid, infoUuid: a.infoUuid, txUuid: a.txUuid, rxUuid: a.rxUuid, name: a.name });
  }

  /** Walk out of (or back into) range: connections drop and the Hub cannot be found until it is back. */
  setInRange(inRange: boolean): void {
    this.handle.setInRange(inRange);
  }

  async support(): Promise<BleSupport> {
    return (
      this.o.support ?? {
        peripheral: { ok: true, maxConnections: 7 },
        central: { ok: true },
      }
    );
  }

  async startAdvertising(opts: AdvertisingOptions): Promise<void> {
    this.adv = opts;
    this.info = opts.info.slice();
    if (!this.link.power) {
      this.emit('state', 'bluetooth-off');
      return;
    }
    this.advertise();
    this.emit('state', 'ready');
  }

  async setInfo(info: Uint8Array): Promise<void> {
    this.info = info.slice();
  }

  async stopAdvertising(): Promise<void> {
    this.adv = undefined;
    this.handle.setAdvertising(null);
  }

  async notify(conn: BleConnId, frame: Uint8Array): Promise<void> {
    try {
      await this.handle.notify(conn, frame);
    } catch (e) {
      const code = (e as { code?: string }).code;
      throw new BleError(code === 'frame-too-large' ? 'frame-too-large' : 'not-connected', (e as Error).message);
    }
  }

  async disconnect(conn: BleConnId): Promise<void> {
    const out = this.outgoing.get(conn);
    if (out) {
      this.outgoing.delete(conn);
      out.close();
      this.emit('disconnected', conn, undefined);
      return;
    }
    await this.handle.disconnect(conn);
  }

  // ---- central role (Hub-to-Hub) ----

  private offScan: (() => void) | undefined;
  private readonly outgoing = new Map<BleConnId, { write(f: Uint8Array): Promise<void>; close(): void }>();
  private nextOut = 0;

  async startScan(serviceUuid: string): Promise<void> {
    this.offScan?.();
    const see = (a: { address: string; name: string }) => {
      if (this.closed || a.address === this.handle.address) return; // not ourselves
      this.emit('seen', { address: a.address, name: a.name });
    };
    for (const a of this.link.advertisers(serviceUuid)) see(a);
    const off = this.link.onAdvertise((a) => a.serviceUuid === serviceUuid && see(a));
    this.offScan = off;
  }
  async stopScan(): Promise<void> {
    this.offScan?.();
    this.offScan = undefined;
  }
  async connect(address: string): Promise<{ conn: BleConnId; mtu: number; info: Uint8Array }> {
    if (this.closed) throw new BleError('bridge-failed', 'bridge is closed');
    const central = await this.link.central({ mtu: 185 });
    let c;
    try {
      c = await central.connect(address);
    } catch (e) {
      throw new BleError('bridge-failed', (e as Error).message);
    }
    const conn = `o${++this.nextOut}`;
    this.outgoing.set(conn, c);
    c.onNotify((f) => this.emit('notify', conn, f));
    c.onDisconnect(() => {
      if (this.outgoing.delete(conn)) this.emit('disconnected', conn, undefined);
    });
    return { conn, mtu: c.mtu, info: c.info };
  }
  async write(conn: BleConnId, frame: Uint8Array): Promise<void> {
    const c = this.outgoing.get(conn);
    if (!c) throw new BleError('not-connected', 'no such connection');
    await c.write(frame);
  }

  on<K extends keyof BleBridgeEvents>(event: K, handler: BleBridgeEvents[K]): () => void {
    this.h[event].add(handler);
    return () => void this.h[event].delete(handler);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.offPower();
    this.offScan?.();
    for (const [, c] of this.outgoing) c.close();
    this.outgoing.clear();
    this.adv = undefined;
    this.handle.unregister();
    for (const k of Object.keys(this.h) as Array<keyof BleBridgeEvents>) this.h[k].clear();
  }
}
