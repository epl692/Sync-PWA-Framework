import type {
  PeerId,
  PeerInfo,
  Transport,
  TransportCapabilities,
  TransportEvents,
  TransportState,
} from '@sync/core';

export interface WebSocketTransportOptions {
  url: string;
  /** Transport id (default "websocket"). Use distinct ids to run several servers. */
  id?: string;
  /** Inject an implementation (e.g. from `ws`). Pass null to force "unsupported". Default: globalThis.WebSocket. */
  WebSocket?: typeof WebSocket | null;
  /** Reconnect backoff. Pass false to disable reconnecting. */
  reconnect?: { minMs?: number; maxMs?: number; factor?: number } | false;
}

type Handlers = { [K in keyof TransportEvents]: Set<TransportEvents[K]> };

const SERVER: PeerId = 'server';

/** WebSocket client transport: one peer (the server), automatic reconnect with backoff. */
export function createWebSocketTransport(opts: WebSocketTransportOptions): Transport {
  return new WebSocketTransport(opts);
}

class WebSocketTransport implements Transport {
  readonly id: string;
  readonly capabilities: TransportCapabilities = { maxMessageBytes: 8 * 1024 * 1024, ordered: true, multiPeer: false, blobs: false };
  private _state: TransportState = 'idle';
  private ws: WebSocket | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private running = false;
  private connected = false;
  private handlers: Handlers = {
    state: new Set(),
    peerConnected: new Set(),
    peerDisconnected: new Set(),
    message: new Set(),
    error: new Set(),
  };

  constructor(private readonly o: WebSocketTransportOptions) {
    this.id = o.id ?? 'websocket';
  }

  get state(): TransportState {
    return this._state;
  }

  private impl(): typeof WebSocket | undefined {
    if (this.o.WebSocket === null) return undefined;
    return this.o.WebSocket ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  }

  supported() {
    return this.impl()
      ? { ok: true as const }
      : { ok: false as const, reason: 'WebSocket is not available in this environment' };
  }

  on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): () => void {
    (this.handlers[event] as Set<TransportEvents[K]>).add(handler);
    return () => void (this.handlers[event] as Set<TransportEvents[K]>).delete(handler);
  }

  private emit<K extends keyof TransportEvents>(event: K, ...args: Parameters<TransportEvents[K]>) {
    for (const h of [...(this.handlers[event] as Set<(...a: unknown[]) => void>)]) {
      try {
        h(...args);
      } catch {
        // listeners must not break the transport
      }
    }
  }

  private setState(s: TransportState, detail?: string) {
    if (this._state === s) return;
    this._state = s;
    this.emit('state', s, detail);
  }

  async start(): Promise<void> {
    if (!this.supported().ok) {
      this.setState('unsupported', 'WebSocket is not available');
      return;
    }
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.open();
  }

  async connect(): Promise<void> {
    return this.start();
  }

  private open(): void {
    const WS = this.impl()!;
    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WS(this.o.url);
    } catch (e) {
      this.emit('error', { code: 'connect-failed', message: String((e as Error).message) });
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.connected = true;
      this.setState('ready');
      const peer: PeerInfo = { id: SERVER, label: this.o.url };
      this.emit('peerConnected', peer);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      const d = ev.data as unknown;
      if (d instanceof ArrayBuffer) this.emit('message', SERVER, new Uint8Array(d));
      else if (ArrayBuffer.isView(d)) this.emit('message', SERVER, new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
      else this.emit('error', { code: 'unexpected-text', message: 'ignored a non-binary frame', peerId: SERVER });
    };
    ws.onerror = () => {
      // 'close' follows; the reconnect is scheduled there
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (this.connected) {
        this.connected = false;
        this.emit('peerDisconnected', SERVER, 'connection closed');
      }
      if (this.running) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.o.reconnect === false || !this.running) {
      this.setState(this.running ? 'error' : 'idle');
      return;
    }
    const { minMs = 250, maxMs = 10_000, factor = 2 } = this.o.reconnect ?? {};
    const delay = Math.min(maxMs, minMs * factor ** this.attempt++);
    this.setState('connecting');
    this.timer = setTimeout(() => this.running && this.open(), delay);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      if (this.connected) {
        this.connected = false;
        this.emit('peerDisconnected', SERVER, 'stopped');
      }
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
    if (this._state !== 'unsupported') this.setState('idle');
  }

  async send(peerId: PeerId, bytes: Uint8Array): Promise<void> {
    const ws = this.ws;
    if (peerId !== SERVER || !ws || !this.connected || ws.readyState !== 1) throw new Error('not connected');
    ws.send(bytes);
  }
}
