/** Transport contract (specs/001-sync-core/contracts/transport.ts). */

export type PeerId = string;

export type TransportState = 'unsupported' | 'idle' | 'needs-pairing' | 'connecting' | 'ready' | 'error';

export interface TransportCapabilities {
  maxMessageBytes: number;
  ordered: boolean;
  multiPeer: boolean;
  blobs: boolean;
}

export interface PeerInfo {
  id: PeerId;
  label?: string;
}

export interface TransportEvents {
  state(state: TransportState, detail?: string): void;
  peerConnected(peer: PeerInfo): void;
  peerDisconnected(peerId: PeerId, reason?: string): void;
  message(peerId: PeerId, bytes: Uint8Array): void;
  error(err: { code: string; message: string; peerId?: PeerId }): void;
}

export interface Transport {
  readonly id: string;
  readonly capabilities: TransportCapabilities;
  readonly state: TransportState;
  supported(): { ok: true } | { ok: false; reason: string };
  start(): Promise<void>;
  connect?(target?: unknown): Promise<void>;
  stop(): Promise<void>;
  send(peerId: PeerId, bytes: Uint8Array): Promise<void>;
  on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): () => void;
  readonly blob?: {
    sendChunk(peerId: PeerId, blobId: string, index: number, bytes: Uint8Array): Promise<void>;
    onChunk(handler: (peerId: PeerId, blobId: string, index: number, bytes: Uint8Array) => void): () => void;
  };
}

export interface TransportFactory<Opts = unknown> {
  create(opts: Opts): Transport;
}
