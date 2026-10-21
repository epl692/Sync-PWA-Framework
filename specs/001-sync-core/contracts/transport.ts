/**
 * Transport contract (FR-013). Implementations move opaque bytes between
 * peers. The sync protocol (contracts/sync-protocol.md) is implemented by the
 * core on top of this, so a transport does not know about packets.
 *
 * Every implementation MUST pass `transportContract()` from @sync/testkit.
 */

export type PeerId = string;

export type TransportState =
  | 'unsupported'          // environment can't run it; app continues
  | 'idle'                 // supported, not started
  | 'needs-pairing'        // e.g. WebRTC waiting for a pairing code exchange
  | 'connecting'
  | 'ready'                // at least the transport itself is usable
  | 'error';

export interface TransportCapabilities {
  /** Largest single message this transport carries unframed. Core chunks to batch limits; the transport frames the rest. */
  maxMessageBytes: number;
  /** True if send() preserves order per peer. Not required: the core tolerates reordering. */
  ordered: boolean;
  /** True if one transport instance can reach many peers at once (server). */
  multiPeer: boolean;
  /** Supports the optional blob hooks used by spec 004. */
  blobs: boolean;
}

export interface PeerInfo {
  id: PeerId;
  /** Human label for UI, e.g. "relay.example.com" or "Maya's phone". */
  label?: string;
}

export interface TransportEvents {
  state(state: TransportState, detail?: string): void;
  peerConnected(peer: PeerInfo): void;
  peerDisconnected(peerId: PeerId, reason?: string): void;
  /** Complete, unframed message from a peer. */
  message(peerId: PeerId, bytes: Uint8Array): void;
  /** Recoverable problem, such as a corrupt frame. MUST NOT break other messages. */
  error(err: { code: string; message: string; peerId?: PeerId }): void;
}

export interface Transport {
  /** Stable plugin ID, e.g. "websocket", "webrtc". */
  readonly id: string;
  readonly capabilities: TransportCapabilities;
  readonly state: TransportState;

  /** Cheap, synchronous environment check. Never throws. */
  supported(): { ok: true } | { ok: false; reason: string };

  /**
   * Begin operating. For transports that need a manual step (WebRTC pairing)
   * this resolves with state 'needs-pairing'; the app then drives pairing
   * through the transport's own API (see contracts/webrtc-pairing.ts).
   */
  start(): Promise<void>;
  /** Optional explicit connect, used where a target (URL, pairing session) is required. */
  connect?(target?: unknown): Promise<void>;
  stop(): Promise<void>;

  /** Resolves when handed to the transport. Rejects if the peer is gone. Delivery is best-effort. */
  send(peerId: PeerId, bytes: Uint8Array): Promise<void>;

  on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): () => void;

  /** Optional blob transfer hooks (spec 004). Core never calls these in spec 001. */
  readonly blob?: {
    sendChunk(peerId: PeerId, blobId: string, index: number, bytes: Uint8Array): Promise<void>;
    onChunk(handler: (peerId: PeerId, blobId: string, index: number, bytes: Uint8Array) => void): () => void;
  };
}

/** Factory shape the contract suite and TransportManager use. */
export interface TransportFactory<Opts = unknown> {
  create(opts: Opts): Transport;
}
