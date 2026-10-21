/** A RelayHub wired to cores in memory, recording every byte that crosses it (for audits). */

import type { PeerInfo, Transport, TransportCapabilities, TransportEvents, TransportState } from '@sync/core';
import { RelayHub, type RelayHubOptions } from '@sync/relay-server';

type Handlers = { [K in keyof TransportEvents]: Set<TransportEvents[K]> };

export class HubNetwork {
  readonly hub: RelayHub;
  /** Every message in either direction, as the relay saw it. */
  readonly seen: Uint8Array[] = [];
  private clients = new Map<string, HubTransport>();

  constructor(opts: RelayHubOptions = {}) {
    this.hub = new RelayHub((peer, bytes) => {
      this.seen.push(bytes.slice());
      const t = this.clients.get(peer);
      if (t) setTimeout(() => t.deliver(bytes.slice()), 0);
    }, opts);
  }

  /** A transport for client `id`. Each client can have several (use different transport ids). */
  transport(id: string, transportId = 'relay'): HubTransport {
    const t = new HubTransport(this, id, transportId);
    this.clients.set(id, t);
    return t;
  }

  fromClient(id: string, bytes: Uint8Array): void {
    this.seen.push(bytes.slice());
    this.hub.onMessage(id, bytes);
  }

  connect(id: string): void {
    this.hub.onConnect(id);
  }

  disconnect(id: string): void {
    this.hub.onDisconnect(id);
  }

  /** Everything the relay stores plus everything that crossed it. */
  everything(): Uint8Array[] {
    return [...this.seen, ...this.hub.inspect().spaces.flatMap((s) => s.packets)];
  }
}

export class HubTransport implements Transport {
  readonly capabilities: TransportCapabilities = { maxMessageBytes: 64 * 1024 * 1024, ordered: true, multiPeer: false, blobs: false };
  private _state: TransportState = 'idle';
  private handlers: Handlers = { state: new Set(), peerConnected: new Set(), peerDisconnected: new Set(), message: new Set(), error: new Set() };
  online = true;

  constructor(
    private readonly net: HubNetwork,
    private readonly clientId: string,
    readonly id: string,
  ) {}

  get state() {
    return this._state;
  }
  supported() {
    return { ok: true as const };
  }
  on<K extends keyof TransportEvents>(event: K, h: TransportEvents[K]) {
    (this.handlers[event] as Set<TransportEvents[K]>).add(h);
    return () => void (this.handlers[event] as Set<TransportEvents[K]>).delete(h);
  }
  private emit<K extends keyof TransportEvents>(event: K, ...args: Parameters<TransportEvents[K]>) {
    for (const h of this.handlers[event] as Set<(...a: unknown[]) => void>) h(...args);
  }
  async start() {
    this._state = 'ready';
    this.emit('state', 'ready');
    if (this.online) this.up();
  }
  private up() {
    this.net.connect(this.clientId);
    const info: PeerInfo = { id: 'relay', label: 'relay' };
    this.emit('peerConnected', info);
  }
  /** Simulate losing and regaining the connection. */
  setOnline(on: boolean) {
    if (on === this.online) return;
    this.online = on;
    if (this._state !== 'ready') return;
    if (on) this.up();
    else {
      this.net.disconnect(this.clientId);
      this.emit('peerDisconnected', 'relay', 'offline');
    }
  }
  async stop() {
    this._state = 'idle';
    this.net.disconnect(this.clientId);
    this.emit('peerDisconnected', 'relay', 'stopped');
  }
  async send(_peerId: string, bytes: Uint8Array) {
    if (!this.online) throw new Error('offline');
    this.net.fromClient(this.clientId, bytes);
  }
  deliver(bytes: Uint8Array) {
    if (this.online) this.emit('message', 'relay', bytes);
  }
}
