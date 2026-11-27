/**
 * MemoryBleLink: a deterministic simulation of Bluetooth LE GATT for tests (spec 005, research R-15).
 *
 * One `MemoryBleLink` is the "air". Peripherals (a `MockBleBridge`, or a test's own endpoint) register on it; clients use
 * `link.bluetooth()`, an object shaped like the part of Web Bluetooth the transport uses. The air models what matters:
 * write-without-response limited to `mtu - 3` bytes, ordered delivery, deterministic loss and duplication (never reordering),
 * latency, disconnects, adapter power, and a peripheral that refuses a connection. Writes with response and INFO reads are reliable.
 */

export interface BleAirOptions {
  /** ATT MTU (default 247). Writes and notifications carry at most `mtu - 3` bytes. */
  mtu?: number;
  /** Overrides the write limit only (a stack that accepts fewer bytes than the MTU allows). */
  maxWriteBytes?: number;
  /** Probability that a frame without response is lost (0..1). */
  lossRate?: number;
  duplicateRate?: number;
  latencyMs?: number;
  /** Seed for the fault generator (default 1). */
  seed?: number;
  /** Expose `bluetooth.getDevices()` and `watchAdvertisements()` like a browser that has them (default false). */
  getDevices?: boolean;
}

export interface Advertising {
  serviceUuid: string;
  infoUuid: string;
  txUuid: string;
  rxUuid: string;
  name: string;
}

/** What a peripheral implements. */
export interface PeripheralEndpoint {
  /** INFO characteristic value. */
  info(): Uint8Array;
  /** Accept (true) or refuse (false) a connection. */
  connect(connId: string, mtu: number): boolean;
  /** One GATT write, exactly as the central sent it. */
  write(connId: string, frame: Uint8Array): void;
  disconnected(connId: string): void;
}

export interface PeripheralHandle {
  setAdvertising(adv: Advertising | null): void;
  /** Rejects with `code: 'frame-too-large'` above `mtu - 3`, or `'not-connected'`. */
  notify(connId: string, frame: Uint8Array): Promise<void>;
  disconnect(connId: string): Promise<void>;
  connections(): string[];
  mtuOf(connId: string): number | undefined;
  setInRange(inRange: boolean): void;
  unregister(): void;
}

class SimError extends Error {
  constructor(
    readonly code: string,
    message: string,
    name = 'NetworkError',
  ) {
    super(message);
    this.name = name;
  }
}

const dom = (name: string, message: string) => Object.assign(new Error(message), { name });

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Peripheral {
  index: number;
  ep: PeripheralEndpoint;
  adv: Advertising | null;
  inRange: boolean;
}

interface Conn {
  id: string;
  p: Peripheral;
  adapter: Adapter;
  mtu: number;
  maxWrite: number;
  open: boolean;
  notifying: boolean;
  rxChar?: FakeChar;
  device: FakeDevice;
  /** Delivery chains keep each direction in order. */
  toPeripheral: Promise<void>;
  toCentral: Promise<void>;
}

interface Adapter {
  o: Required<Omit<BleAirOptions, 'maxWriteBytes'>> & { maxWriteBytes?: number };
  devices: Map<number, FakeDevice>;
  granted: Set<number>;
}

class FakeChar extends EventTarget {
  value: DataView | null = null;
  constructor(
    readonly uuid: string,
    private readonly conn: Conn,
    private readonly kind: 'info' | 'tx' | 'rx',
    private readonly link: MemoryBleLink,
  ) {
    super();
    if (kind === 'rx') conn.rxChar = this;
  }
  private live(): void {
    if (!this.conn.open) throw new SimError('not-connected', 'GATT Server is disconnected. Cannot perform GATT operations.');
  }
  async readValue(): Promise<DataView> {
    this.live();
    if (this.kind !== 'info') throw dom('NotSupportedError', 'GATT operation not permitted.');
    const b = this.conn.p.ep.info().slice(0, 512);
    this.value = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return this.value;
  }
  async writeValueWithoutResponse(v: BufferSource): Promise<void> {
    this.live();
    if (this.kind !== 'tx') throw dom('NotSupportedError', 'GATT operation not permitted.');
    const bytes = toBytes(v);
    if (bytes.length > this.conn.maxWrite) throw new SimError('too-long', 'GATT operation failed: value longer than the allowed write size.');
    this.link._toPeripheral(this.conn, bytes, true);
  }
  async writeValueWithResponse(v: BufferSource): Promise<void> {
    this.live();
    if (this.kind !== 'tx') throw dom('NotSupportedError', 'GATT operation not permitted.');
    const bytes = toBytes(v);
    if (bytes.length > 512) throw new SimError('too-long', 'GATT operation failed: attribute value too long.');
    this.link._toPeripheral(this.conn, bytes, false);
  }
  async writeValue(v: BufferSource): Promise<void> {
    return this.writeValueWithResponse(v);
  }
  async startNotifications(): Promise<this> {
    this.live();
    if (this.kind !== 'rx') throw dom('NotSupportedError', 'GATT operation not permitted.');
    this.conn.notifying = true;
    return this;
  }
  async stopNotifications(): Promise<this> {
    this.conn.notifying = false;
    return this;
  }
}

const toBytes = (v: BufferSource): Uint8Array =>
  v instanceof ArrayBuffer ? new Uint8Array(v.slice(0)) : new Uint8Array((v as ArrayBufferView).buffer.slice((v as ArrayBufferView).byteOffset, (v as ArrayBufferView).byteOffset + (v as ArrayBufferView).byteLength));

class FakeServer {
  constructor(
    private readonly conn: Conn,
    readonly device: FakeDevice,
  ) {}
  get connected(): boolean {
    return this.conn.open;
  }
  disconnect(): void {
    this.device.gatt.disconnect();
  }
  async getPrimaryService(uuid: string) {
    if (!this.conn.open) throw new SimError('not-connected', 'GATT Server is disconnected.');
    const adv = this.conn.p.adv;
    if (!adv || adv.serviceUuid !== uuid) throw dom('NotFoundError', 'No Services matching UUID found in Device.');
    const conn = this.conn;
    const link = this.device.link;
    return {
      device: this.device,
      uuid,
      async getCharacteristic(c: string) {
        const kind = c === adv.infoUuid ? 'info' : c === adv.txUuid ? 'tx' : c === adv.rxUuid ? 'rx' : undefined;
        if (!kind) throw dom('NotFoundError', 'No Characteristics matching UUID found in Service.');
        return new FakeChar(c, conn, kind, link);
      },
    };
  }
}

class FakeGatt {
  server: FakeServer | undefined;
  constructor(private readonly dev: FakeDevice) {}
  get connected(): boolean {
    return this.dev.conn?.open === true;
  }
  async connect(): Promise<FakeServer> {
    if (this.connected && this.server) return this.server;
    this.server = await this.dev.link._connect(this.dev);
    return this.server;
  }
  disconnect(): void {
    if (this.dev.conn?.open) this.dev.link._disconnect(this.dev.conn, 'central');
  }
}

class FakeDevice extends EventTarget {
  conn: Conn | undefined;
  readonly gatt: FakeGatt;
  watching = false;
  constructor(
    readonly link: MemoryBleLink,
    readonly adapter: Adapter,
    readonly p: Peripheral,
  ) {
    super();
    this.gatt = new FakeGatt(this);
  }
  get id(): string {
    return `dev-${this.p.index}`;
  }
  get name(): string | undefined {
    return this.p.adv?.name;
  }
  async watchAdvertisements(): Promise<void> {
    this.watching = true;
    if (this.p.adv && this.p.inRange && this.link.power) setTimeout(() => this.dispatchEvent(new Event('advertisementreceived')), 0);
  }
  async forget(): Promise<void> {
    this.adapter.granted.delete(this.p.index);
  }
}

export interface BluetoothLikeSim {
  requestDevice(opts: { filters?: Array<{ services?: string[] }>; acceptAllDevices?: boolean }): Promise<FakeDevice>;
  getAvailability(): Promise<boolean>;
  getDevices?: () => Promise<FakeDevice[]>;
}

export class MemoryBleLink {
  power = true;
  /** Chooses which device the "user" picks in `requestDevice`. Default: the first. */
  chooser: (devices: FakeDevice[]) => FakeDevice | undefined = (d) => d[0];
  private readonly periph: Peripheral[] = [];
  private readonly conns = new Set<Conn>();
  private readonly adapters = new Set<Adapter>();
  private readonly powerListeners = new Set<(on: boolean) => void>();
  private nextConn = 0;
  private rand: () => number;

  constructor(private readonly base: BleAirOptions = {}) {
    this.rand = mulberry32(base.seed ?? 1);
  }

  registerPeripheral(ep: PeripheralEndpoint): PeripheralHandle {
    const p: Peripheral = { index: this.periph.length, ep, adv: null, inRange: true };
    this.periph.push(p);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const link = this;
    return {
      setAdvertising(adv) {
        p.adv = adv;
        if (adv) link._advertised(p);
      },
      async notify(connId, frame) {
        const c = [...link.conns].find((x) => x.id === connId && x.p === p && x.open);
        if (!c) throw new SimError('not-connected', 'connection is gone');
        if (frame.length > c.mtu - 3) throw new SimError('frame-too-large', `notification larger than mtu - 3 (${c.mtu - 3})`);
        link._toCentral(c, frame.slice());
      },
      async disconnect(connId) {
        const c = [...link.conns].find((x) => x.id === connId && x.p === p);
        if (c) link._disconnect(c, 'peripheral');
      },
      connections: () => [...link.conns].filter((c) => c.p === p && c.open).map((c) => c.id),
      mtuOf: (connId) => [...link.conns].find((c) => c.id === connId && c.p === p)?.mtu,
      setInRange(inRange) {
        p.inRange = inRange;
        if (!inRange) {
          for (const c of [...link.conns]) if (c.p === p && c.open) link._disconnect(c, 'out-of-range');
        } else if (p.adv) {
          link._advertised(p);
        }
      },
      unregister() {
        p.adv = null;
        for (const c of [...link.conns]) if (c.p === p && c.open) link._disconnect(c, 'peripheral');
      },
    };
  }

  /** A client's view of the radio. Per-client options override the link's (a phone with a smaller MTU, a lossier path). */
  bluetooth(over: BleAirOptions = {}): BluetoothLikeSim {
    const o = { mtu: 247, lossRate: 0, duplicateRate: 0, latencyMs: 0, seed: 1, getDevices: false, ...this.base, ...over };
    const adapter: Adapter = { o, devices: new Map(), granted: new Set() };
    this.adapters.add(adapter);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const link = this;
    const deviceFor = (p: Peripheral) => {
      let d = adapter.devices.get(p.index);
      if (!d) adapter.devices.set(p.index, (d = new FakeDevice(link, adapter, p)));
      return d;
    };
    const api: BluetoothLikeSim = {
      async requestDevice(opts) {
        if (!link.power) throw dom('NotFoundError', 'Bluetooth adapter is not available.');
        const wanted = opts.filters?.flatMap((f) => f.services ?? []) ?? [];
        const found = link.periph
          .filter((p) => p.adv && p.inRange && (opts.acceptAllDevices || !wanted.length || wanted.includes(p.adv.serviceUuid)))
          .map(deviceFor);
        const pick = link.chooser(found);
        if (!pick) throw dom('NotFoundError', 'User cancelled the requestDevice() chooser.');
        adapter.granted.add(pick.p.index);
        return pick;
      },
      async getAvailability() {
        return link.power;
      },
    };
    if (o.getDevices) api.getDevices = async () => [...adapter.granted].map((i) => deviceFor(link.periph[i]!));
    return api;
  }

  setPower(on: boolean): void {
    if (this.power === on) return;
    this.power = on;
    if (!on) {
      for (const c of [...this.conns]) if (c.open) this._disconnect(c, 'power-off');
    } else {
      for (const p of this.periph) if (p.adv) this._advertised(p);
    }
    for (const l of [...this.powerListeners]) l(on);
  }

  /** The adapter's power changed (a peripheral reacts to Bluetooth being switched off and on). */
  onPower(h: (on: boolean) => void): () => void {
    this.powerListeners.add(h);
    return () => void this.powerListeners.delete(h);
  }

  connections(): number {
    return [...this.conns].filter((c) => c.open).length;
  }

  // ---- internals used by the fake objects above ----

  async _connect(dev: FakeDevice): Promise<FakeServer> {
    const p = dev.p;
    if (!this.power) throw new SimError('no-adapter', 'Bluetooth adapter is not available.');
    if (!p.adv || !p.inRange) throw new SimError('out-of-range', 'GATT Error: device not found or out of range.');
    const o = dev.adapter.o;
    const id = `c${++this.nextConn}`;
    const mtu = o.mtu;
    if (!p.ep.connect(id, mtu)) throw new SimError('refused', 'GATT Error: connection failed.');
    const conn: Conn = {
      id,
      p,
      adapter: dev.adapter,
      mtu,
      maxWrite: o.maxWriteBytes ?? mtu - 3,
      open: true,
      notifying: false,
      device: dev,
      toPeripheral: Promise.resolve(),
      toCentral: Promise.resolve(),
    };
    dev.conn = conn;
    this.conns.add(conn);
    return new FakeServer(conn, dev);
  }

  _disconnect(c: Conn, _by: string): void {
    if (!c.open) return;
    c.open = false;
    c.notifying = false;
    this.conns.delete(c);
    setTimeout(() => c.device.dispatchEvent(new Event('gattserverdisconnected')), 0);
    c.p.ep.disconnected(c.id);
  }

  private delay(c: Conn): Promise<void> {
    const ms = c.adapter.o.latencyMs;
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
  }

  /** Frames with no acknowledgment can be lost or duplicated; others are reliable. */
  private faults(c: Conn, lossy: boolean): number {
    if (!lossy) return 1;
    const o = c.adapter.o;
    if (o.lossRate > 0 && this.rand() < o.lossRate) return 0;
    if (o.duplicateRate > 0 && this.rand() < o.duplicateRate) return 2;
    return 1;
  }

  _toPeripheral(c: Conn, bytes: Uint8Array, lossy: boolean): void {
    const copies = this.faults(c, lossy);
    for (let i = 0; i < copies; i++) {
      c.toPeripheral = c.toPeripheral.then(() => this.delay(c)).then(() => {
        if (c.open) c.p.ep.write(c.id, bytes.slice());
      });
    }
  }

  _toCentral(c: Conn, bytes: Uint8Array): void {
    if (!c.notifying) return; // nothing is sent to a client that has not subscribed
    const copies = this.faults(c, true);
    for (let i = 0; i < copies; i++) {
      c.toCentral = c.toCentral.then(() => this.delay(c)).then(() => {
        if (!c.open || !c.notifying || !c.rxChar) return;
        const b = bytes.slice();
        c.rxChar.value = new DataView(b.buffer, b.byteOffset, b.byteLength);
        c.rxChar.dispatchEvent(new Event('characteristicvaluechanged'));
      });
    }
  }

  _advertised(p: Peripheral): void {
    if (!this.power || !p.inRange) return;
    for (const a of this.adapters) {
      const d = a.devices.get(p.index);
      if (d?.watching) setTimeout(() => d.dispatchEvent(new Event('advertisementreceived')), 0);
    }
  }
}
