/** In-memory transports for tests: a controllable network between named nodes. */
import type {
  PeerId,
  PeerInfo,
  Transport,
  TransportCapabilities,
  TransportEvents,
  TransportState,
} from '@sync/core';

type Handlers = { [K in keyof TransportEvents]: Set<TransportEvents[K]> };

interface Queued {
  deliver: () => void;
}

export interface MemoryNetworkOptions {
  /** When false, messages wait until flush() (lets tests control delivery order). Default true. */
  autoDeliver?: boolean;
}

export class MemoryNetwork {
  autoDeliver: boolean;
  private nodes = new Map<string, MemoryTransport>();

  find(transportId: string, name: string): MemoryTransport | undefined {
    return this.nodes.get(`${transportId}/${name}`);
  }

  /** Re-evaluate every link of one transport (after it starts or stops). */
  reconcile(t: MemoryTransport): void {
    for (const other of this.nodes.values()) {
      if (other.id === t.id && other.name !== t.name) this.refresh(t.name, other.name, t.id);
    }
  }
  private severed = new Set<string>();
  private queue: Queued[] = [];
  private linked = new Set<string>();
  private taps: ((from: string, to: string, bytes: Uint8Array, transportId: string) => void)[] = [];

  /** Observe every message handed to the network (before any loss), e.g. to count packets on the wire. */
  tap(cb: (from: string, to: string, bytes: Uint8Array, transportId: string) => void): void {
    this.taps.push(cb);
  }

  observe(from: string, to: string, bytes: Uint8Array, tid: string): void {
    for (const t of this.taps) t(from, to, bytes, tid);
  }

  constructor(opts: MemoryNetworkOptions = {}) {
    this.autoDeliver = opts.autoDeliver ?? true;
  }

  /** A transport for node `name`. Several transports may exist per node (use different `transportId`). */
  transport(name: string, transportId = 'memory'): MemoryTransport {
    const key = `${transportId}/${name}`;
    let t = this.nodes.get(key);
    if (!t) this.nodes.set(key, (t = new MemoryTransport(this, name, transportId)));
    return t;
  }

  private pairKey(a: string, b: string, tid: string) {
    return [a, b].sort().join('|') + '@' + tid;
  }

  /** Connect two nodes over the same transport id. Peers appear once both sides have started. */
  link(a: string, b: string, transportId = 'memory'): void {
    this.linked.add(this.pairKey(a, b, transportId));
    this.refresh(a, b, transportId);
  }

  sever(a: string, b: string, transportId = 'memory'): void {
    this.severed.add(this.pairKey(a, b, transportId));
    this.refresh(a, b, transportId);
  }

  restore(a: string, b: string, transportId = 'memory'): void {
    this.severed.delete(this.pairKey(a, b, transportId));
    this.refresh(a, b, transportId);
  }

  isUp(a: string, b: string, tid: string): boolean {
    const k = this.pairKey(a, b, tid);
    return this.linked.has(k) && !this.severed.has(k);
  }

  refresh(a: string, b: string, tid: string): void {
    const ta = this.find(tid, a);
    const tb = this.find(tid, b);
    ta?.sync(b, tb);
    tb?.sync(a, ta);
  }

  enqueue(deliver: () => void): void {
    this.queue.push({ deliver });
    if (this.autoDeliver) queueMicrotask(() => this.flush());
  }

  /** Deliver every queued message (and any produced while delivering, if autoDeliver). */
  flush(): void {
    while (this.queue.length) this.queue.shift()!.deliver();
  }

  get pending(): number {
    return this.queue.length;
  }
}

export class MemoryTransport implements Transport {
  readonly capabilities: TransportCapabilities = { maxMessageBytes: 64 * 1024 * 1024, ordered: true, multiPeer: true, blobs: false };
  private _state: TransportState = 'idle';
  private handlers: Handlers = { state: new Set(), peerConnected: new Set(), peerDisconnected: new Set(), message: new Set(), error: new Set() };
  private connected = new Set<string>();

  constructor(
    private readonly net: MemoryNetwork,
    readonly name: string,
    readonly id: string,
  ) {}

  get state(): TransportState {
    return this._state;
  }

  supported() {
    return { ok: true as const };
  }

  private setState(s: TransportState) {
    this._state = s;
    for (const h of this.handlers.state) h(s);
  }

  on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): () => void {
    (this.handlers[event] as Set<TransportEvents[K]>).add(handler);
    return () => void (this.handlers[event] as Set<TransportEvents[K]>).delete(handler);
  }

  private emit<K extends keyof TransportEvents>(event: K, ...args: Parameters<TransportEvents[K]>) {
    for (const h of this.handlers[event] as Set<(...a: unknown[]) => void>) h(...args);
  }

  async start(): Promise<void> {
    this.setState('ready');
    this.net.reconcile(this);
  }

  async stop(): Promise<void> {
    for (const p of [...this.connected]) {
      this.connected.delete(p);
      this.emit('peerDisconnected', p, 'stopped');
    }
    this.setState('idle');
    this.net.reconcile(this);
  }

  async connect(): Promise<void> {
    await this.start();
  }

  deliver(from: string, bytes: Uint8Array): void {
    this.emit('message', from, bytes);
  }

  /** Reconcile our view of one peer with the network. Called by the network. */
  sync(peer: string, other: MemoryTransport | undefined): void {
    const up = this._state === 'ready' && !!other && other._state === 'ready' && this.net.isUp(this.name, peer, this.id);
    const was = this.connected.has(peer);
    if (up && !was) {
      this.connected.add(peer);
      const info: PeerInfo = { id: peer, label: peer };
      this.emit('peerConnected', info);
    } else if (!up && was) {
      this.connected.delete(peer);
      this.emit('peerDisconnected', peer, 'link down');
    }
  }

  async send(peerId: PeerId, bytes: Uint8Array): Promise<void> {
    if (!this.connected.has(peerId)) throw new Error(`peer ${peerId} is not connected`);
    const copy = bytes.slice();
    this.net.observe(this.name, peerId, copy, this.id);
    const target = this.net.find(this.id, peerId);
    this.net.enqueue(() => {
      if (!target || !this.net.isUp(this.name, peerId, this.id)) return; // lost in flight
      target.deliver(this.name, copy);
    });
  }
}

/** A transport whose environment cannot run it: supported() is false and start() leaves it 'unsupported'. */
export function unsupportedTransport(id = 'unsupported', reason = 'not available in this environment'): Transport {
  const handlers: { [K in keyof TransportEvents]: Set<TransportEvents[K]> } = {
    state: new Set(),
    peerConnected: new Set(),
    peerDisconnected: new Set(),
    message: new Set(),
    error: new Set(),
  };
  let state: TransportState = 'idle';
  return {
    id,
    capabilities: { maxMessageBytes: 1, ordered: true, multiPeer: false, blobs: false },
    get state() {
      return state;
    },
    supported: () => ({ ok: false, reason }),
    async start() {
      state = 'unsupported';
      for (const h of handlers.state) h('unsupported', reason);
    },
    async stop() {},
    async send() {
      throw new Error('unsupported');
    },
    on<K extends keyof TransportEvents>(event: K, h: TransportEvents[K]) {
      (handlers[event] as Set<TransportEvents[K]>).add(h);
      return () => void (handlers[event] as Set<TransportEvents[K]>).delete(h);
    },
  };
}
