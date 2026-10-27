/**
 * RelayHub: opaque store-and-forward for Data Packets. It speaks the sync protocol but never decodes
 * packet bodies, so it needs no keys and sees only envelope metadata (Principle V). State is in memory:
 * after a restart clients simply resend what the hub lacks.
 */

import {
  ANY_SPACE,
  EnvelopeError,
  PROTOCOL,
  addValue,
  b64urlDecode,
  b64urlEncode,
  containsValue,
  decodeEnvelope,
  decodeMessage,
  diffIntervals,
  encodeMessage,
  splitPacketId,
  type Held,
  type Msg,
} from '@sync/core';

export interface RelayHubOptions {
  maxMessageBytes?: number;
  maxEnvelopeBytes?: number;
  batchPackets?: number;
  batchBytes?: number;
  deviceName?: string;
}

interface SpaceStore {
  held: Held;
  packets: Map<string, Uint8Array>;
}

interface Peer {
  spaces: Set<string>;
  peerHeld: Map<string, Held>;
  dead: boolean;
}

export class RelayHub {
  private spaces = new Map<string, SpaceStore>();
  private peers = new Map<string, Peer>();
  /** Binary lanes (spec 004, B-1): messages whose first byte is a registered magic bypass the sync protocol. */
  private lanes = new Map<number, (peerId: string, bytes: Uint8Array) => void>();
  private laneGone = new Set<(peerId: string) => void>();
  private readonly o: Required<RelayHubOptions>;

  constructor(
    private readonly send: (peerId: string, bytes: Uint8Array) => void,
    opts: RelayHubOptions = {},
  ) {
    this.o = {
      maxMessageBytes: opts.maxMessageBytes ?? 4 * 1024 * 1024,
      maxEnvelopeBytes: opts.maxEnvelopeBytes ?? 256 * 1024,
      batchPackets: opts.batchPackets ?? 500,
      batchBytes: opts.batchBytes ?? 1024 * 1024,
      deviceName: opts.deviceName ?? 'relay',
    };
  }

  private store(space: string): SpaceStore {
    let s = this.spaces.get(space);
    if (!s) this.spaces.set(space, (s = { held: {}, packets: new Map() }));
    return s;
  }

  private emit(peerId: string, m: Msg): void {
    this.send(peerId, encodeMessage(m));
  }

  /** Register a lane handler (for example the blob relay). Peers that connect afterwards are told the lane exists. */
  onLane(magic: number, handler: (peerId: string, bytes: Uint8Array) => void): void {
    if (!Number.isInteger(magic) || magic < 0x80 || magic > 0xff) throw new RangeError(`lane magic must be 0x80..0xff, got ${magic}`);
    this.lanes.set(magic, handler);
  }
  /** Called when a peer disconnects, so a lane handler can drop its state for it. */
  onLanePeerGone(cb: (peerId: string) => void): () => void {
    this.laneGone.add(cb);
    return () => void this.laneGone.delete(cb);
  }
  /** Send raw bytes to a connected peer (a lane message). */
  sendLane(peerId: string, bytes: Uint8Array): void {
    if (this.peers.has(peerId)) this.send(peerId, bytes);
  }
  /** The Spaces a peer declared in its hello. */
  peerSpaces(peerId: string): ReadonlySet<string> {
    return this.peers.get(peerId)?.spaces ?? new Set();
  }

  onConnect(peerId: string): void {
    this.peers.set(peerId, { spaces: new Set(), peerHeld: new Map(), dead: false });
    const lanes = [...this.lanes.keys()].sort((a, b) => a - b);
    this.emit(peerId, { t: 'hello', protocol: { ...PROTOCOL }, device: this.o.deviceName, spaces: [ANY_SPACE], relay: true, ...(lanes.length ? { lanes } : {}) });
  }

  onDisconnect(peerId: string): void {
    this.peers.delete(peerId);
    for (const cb of [...this.laneGone]) cb(peerId);
  }

  /** Everything the hub currently stores, for audits (for example the plaintext scan, SC-002). Read-only copies. */
  inspect(): { spaces: Array<{ space: string; packets: Uint8Array[] }> } {
    return { spaces: [...this.spaces.entries()].map(([space, s]) => ({ space, packets: [...s.packets.values()].map((p) => p.slice()) })) };
  }

  get stats() {
    return {
      peers: this.peers.size,
      spaces: this.spaces.size,
      packets: [...this.spaces.values()].reduce((n, s) => n + s.packets.size, 0),
    };
  }

  onMessage(peerId: string, bytes: Uint8Array): void {
    const peer = this.peers.get(peerId);
    if (!peer || peer.dead) return;
    if (bytes.length > 0 && bytes[0]! >= 0x80) {
      if (bytes.length <= this.o.maxMessageBytes) this.lanes.get(bytes[0]!)?.(peerId, bytes);
      return; // a lane message never reaches the sync decoder
    }
    const d = decodeMessage(bytes, this.o.maxMessageBytes);
    if (!d.ok || 'unknown' in d) return; // malformed or from the future: ignore
    const m = d.msg;
    switch (m.t) {
      case 'hello': {
        const lo = Math.max(PROTOCOL.min, m.protocol.min);
        const hi = Math.min(PROTOCOL.max, m.protocol.max);
        if (lo > hi) {
          this.emit(peerId, { t: 'error', code: 'protocol-mismatch', message: 'no common protocol version', fatal: true });
          peer.dead = true;
          return;
        }
        for (const space of m.spaces) {
          if (space === ANY_SPACE || peer.spaces.has(space)) continue;
          peer.spaces.add(space);
          this.emit(peerId, { t: 'summary', space, held: structuredClone(this.store(space).held) });
        }
        return;
      }
      case 'summary':
        if (!peer.spaces.has(m.space)) return;
        peer.peerHeld.set(m.space, structuredClone(m.held));
        this.pushMissing(peerId, peer, m.space, this.missing(m.space, m.held));
        return;
      case 'want':
        if (peer.spaces.has(m.space)) this.pushMissing(peerId, peer, m.space, m.ranges);
        return;
      case 'packets':
        this.onPackets(peerId, peer, m.space, m.items);
        return;
      case 'chan': {
        // A-4: plugin messages (invite handshakes). Forwarded, never stored, never decoded.
        if (!peer.spaces.size) return; // the sender must have said hello
        for (const [otherId, other] of this.peers) {
          if (otherId === peerId || other.dead) continue;
          if (m.space === ANY_SPACE || other.spaces.has(m.space)) this.emit(otherId, m);
        }
        return;
      }
      case 'ping':
        this.emit(peerId, { t: 'pong' });
        return;
      default:
        return;
    }
  }

  private missing(space: string, theirs: Held): Held {
    const mine = this.store(space).held;
    const out: Held = {};
    for (const [author, iv] of Object.entries(mine)) {
      const dd = diffIntervals(iv, theirs[author] ?? []);
      if (dd.length) out[author] = dd;
    }
    return out;
  }

  private pushMissing(peerId: string, peer: Peer, space: string, ranges: Held): void {
    const store = this.store(space);
    let items: string[] = [];
    let ids: string[] = [];
    let size = 0;
    const flush = () => {
      if (!items.length) return;
      this.emit(peerId, { t: 'packets', space, items });
      for (const id of ids) this.markHeld(peer, space, id);
      items = [];
      ids = [];
      size = 0;
    };
    for (const [author, iv] of Object.entries(ranges)) {
      for (const [lo, hi] of iv) {
        for (let seq = lo; seq <= hi; seq++) {
          const id = `${author}:${seq}`;
          const raw = store.packets.get(id);
          if (!raw) continue;
          const b64 = b64urlEncode(raw);
          if (items.length && (items.length >= this.o.batchPackets || size + b64.length > this.o.batchBytes)) flush();
          items.push(b64);
          ids.push(id);
          size += b64.length;
        }
      }
    }
    flush();
  }

  private markHeld(peer: Peer, space: string, id: string): void {
    const p = splitPacketId(id);
    if (!p) return;
    const held = peer.peerHeld.get(space) ?? {};
    held[p.author] = addValue(held[p.author] ?? [], p.seq);
    peer.peerHeld.set(space, held);
  }

  private onPackets(from: string, peer: Peer, space: string, items: string[]): void {
    if (!peer.spaces.has(space)) return;
    const store = this.store(space);
    const accepted: string[] = [];
    for (const item of items) {
      let raw: Uint8Array;
      let id: string;
      let seq: number;
      let author: string;
      try {
        raw = b64urlDecode(item);
        const { env } = decodeEnvelope(raw, this.o.maxEnvelopeBytes);
        if (env.space !== space) continue;
        ({ id, seq, author } = env);
      } catch (e) {
        if (!(e instanceof EnvelopeError) && !(e instanceof Error)) throw e;
        continue; // corrupt item: skip it, keep the rest of the batch
      }
      this.markHeld(peer, space, id);
      accepted.push(id);
      if (containsValue(store.held[author] ?? [], seq)) continue; // duplicate: acked, not forwarded
      store.held[author] = addValue(store.held[author] ?? [], seq);
      store.packets.set(id, raw);
      for (const [otherId, other] of this.peers) {
        if (otherId === from || !other.spaces.has(space) || other.dead) continue;
        const known = other.peerHeld.get(space)?.[author] ?? [];
        if (containsValue(known, seq)) continue;
        this.emit(otherId, { t: 'packets', space, items: [item] });
        this.markHeld(other, space, id);
      }
    }
    if (accepted.length) this.emit(from, { t: 'ack', space, ids: accepted });
  }
}
