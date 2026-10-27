/**
 * Binary lanes (spec 004, B-1): bulk byte streams that bypass the JSON sync decoder and the per-peer packet queue.
 * A lane is identified by a magic byte (0x80..0xFF; JSON sync messages begin with "{" = 0x7B). A peer advertises the lanes
 * it understands in `hello.lanes`, and lane messages are only ever sent to such peers.
 */

import type { PeerSummary } from './channel';

/** A connected peer that advertised the lane. Same shape as every peer summary. */
export type LanePeer = PeerSummary;

export interface Lane {
  readonly magic: number;
  /** Connected peers that advertised this lane. */
  peers(): LanePeer[];
  /** `bytes` MUST start with `magic`. Goes straight to Transport.send, never through the session's packet queue. */
  send(peerKey: string, bytes: Uint8Array): Promise<void>;
  onMessage(handler: (peerKey: string, bytes: Uint8Array) => void): () => void;
  /** Fires when a peer becomes (or stops being) a lane peer. Peers already connected are listed by `peers()`. */
  onPeer(handler: (e: { type: 'up' | 'down'; peer: LanePeer }) => void): () => void;
}

interface LaneState {
  messages: Set<(peerKey: string, bytes: Uint8Array) => void>;
  peerHandlers: Set<(e: { type: 'up' | 'down'; peer: LanePeer }) => void>;
  up: Map<string, LanePeer>;
}

export class LaneRegistry {
  private lanes = new Map<number, LaneState>();
  /** Set by the transport manager. */
  listPeers: () => PeerSummary[] = () => [];
  sendRaw: (peerKey: string, bytes: Uint8Array) => Promise<void> = () => Promise.reject(new Error('no transport manager'));
  /** The set of advertised magics changed: re-send `hello`. */
  onChange: () => void = () => undefined;

  magics(): number[] {
    return [...this.lanes.keys()].sort((a, b) => a - b);
  }

  lane(magic: number): Lane {
    if (!Number.isInteger(magic) || magic < 0x80 || magic > 0xff) throw new Error(`lane magic must be an integer from 0x80 to 0xff, got ${magic}`);
    if (this.lanes.has(magic)) throw new Error(`lane 0x${magic.toString(16)} is already registered`);
    const st: LaneState = { messages: new Set(), peerHandlers: new Set(), up: new Map() };
    // Peers that already advertised this lane count as up (without an event, `peers()` lists them), so their disconnect is reported.
    for (const p of this.listPeers()) if (p.lanes.includes(magic)) st.up.set(p.key, p);
    this.lanes.set(magic, st);
    this.onChange();
    const hex = `0x${magic.toString(16)}`;
    return {
      magic,
      peers: () => this.listPeers().filter((p) => p.lanes.includes(magic)),
      send: async (peerKey, bytes) => {
        if (bytes.length === 0 || bytes[0] !== magic) throw new Error(`lane ${hex} message must start with the magic byte`);
        if (!this.listPeers().some((p) => p.key === peerKey && p.lanes.includes(magic))) {
          throw new Error(`peer ${peerKey} does not support lane ${hex}`);
        }
        await this.sendRaw(peerKey, bytes);
      },
      onMessage: (h) => {
        st.messages.add(h);
        return () => void st.messages.delete(h);
      },
      onPeer: (h) => {
        st.peerHandlers.add(h);
        return () => void st.peerHandlers.delete(h);
      },
    };
  }

  /** Deliver an inbound lane message. False when no lane owns the magic. */
  dispatch(magic: number, peerKey: string, bytes: Uint8Array): boolean {
    const st = this.lanes.get(magic);
    if (!st) return false;
    for (const h of [...st.messages]) {
      try {
        h(peerKey, bytes);
      } catch {
        // a faulty plugin must never break the core
      }
    }
    return true;
  }

  /** A peer's hello arrived (or changed). */
  peerHello(peer: PeerSummary): void {
    for (const [magic, st] of this.lanes) {
      if (!peer.lanes.includes(magic)) continue;
      const was = st.up.has(peer.key);
      st.up.set(peer.key, peer);
      if (!was) this.notify(st, { type: 'up', peer });
    }
  }

  peerGone(peerKey: string): void {
    for (const st of this.lanes.values()) {
      const peer = st.up.get(peerKey);
      if (!peer) continue;
      st.up.delete(peerKey);
      this.notify(st, { type: 'down', peer });
    }
  }

  private notify(st: LaneState, e: { type: 'up' | 'down'; peer: LanePeer }): void {
    for (const h of [...st.peerHandlers]) {
      try {
        h(e);
      } catch {
        // a faulty plugin must never break the core
      }
    }
  }
}
