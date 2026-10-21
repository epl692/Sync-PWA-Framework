/**
 * A tiny in-memory stand-in for RTCPeerConnection / RTCDataChannel, enough to drive the WebRTC transport
 * in unit and contract tests. The mock "SDP" carries the connection id, so applying an answer on the
 * offering side links the two data channels. Real browsers are covered by the Playwright test.
 */

type Listener = (ev: any) => void;

export class MockDataChannel {
  readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting';
  binaryType = 'blob';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: Listener | null = null;
  onclose: Listener | null = null;
  onmessage: Listener | null = null;
  onerror: Listener | null = null;
  other: MockDataChannel | undefined;
  private listeners = new Map<string, Set<Listener>>();

  constructor(
    readonly label: string,
    private readonly maxMessageSize: number,
  ) {}

  addEventListener(type: string, cb: Listener) {
    (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(cb);
  }
  removeEventListener(type: string, cb: Listener) {
    this.listeners.get(type)?.delete(cb);
  }

  open() {
    if (this.readyState !== 'connecting') return;
    this.readyState = 'open';
    queueMicrotask(() => {
      this.onopen?.({ type: 'open' });
      this.listeners.get('open')?.forEach((l) => l({ type: 'open' }));
    });
  }

  send(data: ArrayBuffer | ArrayBufferView) {
    if (this.readyState !== 'open') throw new Error('InvalidStateError: data channel is not open');
    const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice() : new Uint8Array(data.slice(0));
    if (bytes.length > this.maxMessageSize) throw new TypeError(`message of ${bytes.length} bytes exceeds the ${this.maxMessageSize} byte limit`);
    const peer = this.other;
    queueMicrotask(() => {
      if (peer && peer.readyState === 'open') peer.onmessage?.({ data: bytes.buffer });
    });
  }

  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    const peer = this.other;
    queueMicrotask(() => {
      this.onclose?.({ type: 'close' });
      if (peer && peer.readyState !== 'closed') peer.close();
    });
  }
}

export class MockPeerConnection {
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  iceGatheringState: 'new' | 'gathering' | 'complete' = 'new';
  connectionState: 'new' | 'connecting' | 'connected' | 'failed' | 'closed' = 'new';
  closed = false;
  channels: MockDataChannel[] = [];
  onicecandidate: Listener | null = null;
  onicegatheringstatechange: Listener | null = null;
  onconnectionstatechange: Listener | null = null;
  ondatachannel: Listener | null = null;

  constructor(
    private readonly hub: MockRtc,
    readonly id: string,
  ) {}

  addEventListener() {}
  removeEventListener() {}

  createDataChannel(label: string) {
    const ch = new MockDataChannel(label, this.hub.maxMessageSize);
    this.channels.push(ch);
    return ch;
  }

  async createOffer() {
    return { type: 'offer', sdp: `mock-sdp:${this.id}` };
  }
  async createAnswer() {
    return { type: 'answer', sdp: `mock-sdp:${this.id}` };
  }

  async setLocalDescription(desc: { type: string; sdp: string }) {
    this.localDescription = desc;
    this.iceGatheringState = 'gathering';
    queueMicrotask(() => {
      this.iceGatheringState = 'complete';
      this.onicegatheringstatechange?.({});
      this.onicecandidate?.({ candidate: null });
    });
  }

  async setRemoteDescription(desc: { type: string; sdp: string }) {
    this.remoteDescription = desc;
    const other = this.hub.byId(desc.sdp.replace('mock-sdp:', ''));
    if (!other || other.closed) return; // nobody home: the channel will simply never open
    if (desc.type === 'offer') {
      const mine = new MockDataChannel('sync', this.hub.maxMessageSize);
      this.channels.push(mine);
      queueMicrotask(() => this.ondatachannel?.({ channel: mine }));
    } else {
      const theirs = other.channels[0];
      const ours = this.channels[0];
      if (!theirs || !ours || this.hub.dropOpen) return;
      ours.other = theirs;
      theirs.other = ours;
      this.connectionState = other.connectionState = 'connected';
      ours.open();
      theirs.open();
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.connectionState = 'closed';
    for (const ch of this.channels) ch.close();
    queueMicrotask(() => this.onconnectionstatechange?.({}));
  }
}

export class MockRtc {
  readonly pcs: MockPeerConnection[] = [];
  /** When true, applying an answer never opens the channels (simulates an unreachable peer). */
  dropOpen = false;
  private next = 0;

  constructor(readonly maxMessageSize = 16 * 1024) {}

  byId(id: string) {
    return this.pcs.find((p) => p.id === id);
  }

  /** Pass as the transport's RTCPeerConnection option. */
  get RTCPeerConnection(): typeof RTCPeerConnection {
    return rtcClassFor(this);
  }

  create(): MockPeerConnection {
    const pc = new MockPeerConnection(this, `pc${this.next++}`);
    this.pcs.push(pc);
    return pc;
  }
}

function rtcClassFor(hub: MockRtc): typeof RTCPeerConnection {
  return class {
    constructor() {
      return hub.create() as unknown as object;
    }
  } as unknown as typeof RTCPeerConnection;
}
