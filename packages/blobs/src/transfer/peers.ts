/**
 * The lane peer table: who can talk blob/1 to us, what window they allow, and what they refused this session.
 * A peer is a lane peer only if its sync `hello` advertised the lane (B-1); the blob `hello` then exchanges parameters.
 */

import { windowFor } from '../config';
import type { Engine } from '../engine';
import { decodeMessage, encodeMessage, type LaneMsg } from '../protocol/codec';
import type { LanePeer } from '@sync/core';

export const BLOB_PROTOCOL = 1;
export const DEFAULT_MAX_CHUNKS = 4096;
export const MAX_OFFERS_PER_SECOND = 64;

export interface PeerState {
  key: string;
  helloSent: boolean;
  /** Parameters the peer announced; undefined until its hello arrives. */
  hello?: { v: number; window: number; serve: boolean; maxChunks: number };
  /** Blob IDs this peer refused (`reject`) during this session: not offered to it again. */
  rejected: Set<string>;
  /** Failed verification counts per blob ID this session (three strikes: not asked again). */
  strikes: Map<string, number>;
  /** Times of recent `offer` messages from this peer, for the flood limit. */
  offerTimes: number[];
}

export interface PeerHooks {
  /** The peer's blob hello arrived and it speaks our version. */
  onReady(peerKey: string): void;
  onGone(peerKey: string): void;
}

export class PeerTable {
  private peers = new Map<string, PeerState>();
  private unsubs: Array<() => void> = [];

  constructor(
    private readonly e: Engine,
    private readonly hooks: PeerHooks,
  ) {}

  start(): void {
    this.unsubs.push(
      this.e.lane.onPeer(({ type, peer }) => {
        if (type === 'up') void this.sendHello(peer.key);
        else this.drop(peer.key);
      }),
    );
    for (const p of this.e.lane.peers()) void this.sendHello(p.key);
  }

  stop(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.peers.clear();
  }

  state(key: string): PeerState | undefined {
    return this.peers.get(key);
  }

  private ensure(key: string): PeerState {
    let s = this.peers.get(key);
    if (!s) this.peers.set(key, (s = { key, helloSent: false, rejected: new Set(), strikes: new Map(), offerTimes: [] }));
    return s;
  }

  private drop(key: string): void {
    if (this.peers.delete(key)) this.hooks.onGone(key);
  }

  /** The current lane summary of a peer (spaces, transport capabilities), or undefined when it is not connected. */
  info(key: string): LanePeer | undefined {
    return this.e.lane.peers().find((p) => p.key === key);
  }

  /** Peers that completed the hello exchange and speak this protocol version. */
  ready(): PeerState[] {
    return [...this.peers.values()].filter((p) => p.hello?.v === BLOB_PROTOCOL && !!this.info(p.key));
  }

  /** The peer syncs `space` with us (a relay that holds data for everyone reports "*"). */
  shares(key: string, space: string): boolean {
    const i = this.info(key);
    return !!i && (i.spaces.includes('*') || i.spaces.includes(space));
  }

  /** Flood limit (blob-protocol.md Rules): at most 64 offers per second per peer; the excess is dropped. */
  allowOffer(key: string): boolean {
    const s = this.ensure(key);
    const now = Date.now();
    s.offerTimes = s.offerTimes.filter((t) => now - t < 1000);
    if (s.offerTimes.length >= MAX_OFFERS_PER_SECOND) return false;
    s.offerTimes.push(now);
    return true;
  }

  async send(key: string, msg: LaneMsg): Promise<boolean> {
    try {
      await this.e.lane.send(key, encodeMessage(msg));
      return true;
    } catch {
      return false; // the peer went away, or has not yet announced the lane
    }
  }

  private async sendHello(key: string): Promise<void> {
    const s = this.ensure(key);
    if (s.helloSent) return;
    const info = this.info(key);
    // marked sent only once it went out, so a later `up` event retries a hello that raced the peer's sync hello
    s.helloSent = await this.send(key, {
      type: 'hello',
      v: BLOB_PROTOCOL,
      window: windowFor(this.e.cfg, info?.bulk ?? false),
      maxChunks: DEFAULT_MAX_CHUNKS,
      serve: this.e.cfg.serve,
    });
  }

  onHello(key: string, m: Extract<LaneMsg, { type: 'hello' }>): void {
    const s = this.ensure(key);
    const fresh = !s.hello;
    s.hello = { v: m.v, window: Math.max(1, m.window), serve: m.serve, maxChunks: m.maxChunks };
    if (!s.helloSent) void this.sendHello(key); // the peer's hello can arrive before our lane peer event
    if (fresh && m.v === BLOB_PROTOCOL) this.hooks.onReady(key);
  }
}

export { decodeMessage };
