/**
 * Answering `get` (research R-06, blob-protocol.md): send the manifest and the requested chunks the device holds (every
 * stored chunk was verified when it was written), answer `miss` for the rest, never queue more than one chunk message
 * per peer, yield between chunks, and stop on `cancel`. Per-peer limits keep a flood from becoming a denial of service.
 */

import type { Engine } from '../engine';
import { chunkCount } from '../format/manifest';
import type { LaneMsg, Range } from '../protocol/codec';
import { coalesce } from '../transfer/scheduler';

export const MAX_PENDING_RANGES = 256;

interface Item {
  id: string;
  space: string;
  manifest: boolean;
  ranges: Range[];
}

interface PeerQueue {
  items: Item[];
  running: boolean;
  pendingRanges: number;
  cancelled: Set<string>;
}

const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));

export class Server {
  private queues = new Map<string, PeerQueue>();

  constructor(private readonly e: Engine) {}

  private queue(peer: string): PeerQueue {
    let q = this.queues.get(peer);
    if (!q) this.queues.set(peer, (q = { items: [], running: false, pendingRanges: 0, cancelled: new Set() }));
    return q;
  }

  onGet(peer: string, m: Extract<LaneMsg, { type: 'get' }>): void {
    if (!this.e.cfg.serve) return void this.e.peers.send(peer, { type: 'reject', id: m.id, reason: 'unsupported' });
    if (!this.e.peers.shares(peer, m.space)) return void this.e.peers.send(peer, { type: 'reject', id: m.id, reason: 'space' });
    const q = this.queue(peer);
    if (q.pendingRanges + m.ranges.length > MAX_PENDING_RANGES) return void this.e.peers.send(peer, { type: 'reject', id: m.id, reason: 'busy' });
    q.items.push({ id: m.id, space: m.space, manifest: m.manifest, ranges: m.ranges });
    q.pendingRanges += m.ranges.length;
    q.cancelled.delete(m.id);
    if (!q.running) void this.run(peer, q);
  }

  onCancel(peer: string, id: string): void {
    const q = this.queues.get(peer);
    if (!q) return;
    q.cancelled.add(id);
    const keep: Item[] = [];
    for (const it of q.items) {
      if (it.id === id && it !== q.items[0]) q.pendingRanges -= it.ranges.length;
      else keep.push(it);
    }
    q.items = keep;
  }

  onPeerGone(peer: string): void {
    this.queues.delete(peer);
  }

  private async run(peer: string, q: PeerQueue): Promise<void> {
    q.running = true;
    try {
      while (q.items.length && !this.e.closed) {
        const item = q.items[0]!;
        await this.serve(peer, q, item).catch(() => undefined);
        q.items.shift();
        q.pendingRanges -= item.ranges.length;
        q.cancelled.delete(item.id);
      }
    } finally {
      q.running = false;
    }
  }

  private async serve(peer: string, q: PeerQueue, item: Item): Promise<void> {
    const rec = await this.e.storage.getBlob(item.id);
    if (!rec) {
      await this.e.peers.send(peer, { type: 'miss', id: item.id, ranges: item.ranges });
      return;
    }
    if (item.manifest && !q.cancelled.has(item.id)) await this.e.peers.send(peer, { type: 'manifest', id: item.id, manifest: rec.manifest });
    const n = chunkCount(rec.size);
    const missing: number[] = [];
    const beyond: Range[] = []; // indexes past the end of the blob: reported as misses, never iterated
    for (const [lo, hi] of item.ranges) {
      if (hi >= n) beyond.push([Math.max(lo, n), hi]);
      for (let i = lo; i <= Math.min(hi, n - 1); i++) {
        if (q.cancelled.has(item.id) || this.e.closed) return;
        const stored = await this.e.storage.getChunk(item.id, i);
        if (!stored) {
          missing.push(i);
          continue;
        }
        if (!(await this.e.peers.send(peer, { type: 'chunk', id: item.id, index: i, stored }))) return; // the peer is gone
        await yieldNow(); // let packets and other work through between chunks (FR-003)
      }
    }
    const miss = [...coalesce(missing), ...beyond];
    if (miss.length) await this.e.peers.send(peer, { type: 'miss', id: item.id, ranges: miss });
    await this.e.storage.putBlob({ ...rec, lastAccessAt: this.e.now() }).catch(() => undefined);
  }
}
