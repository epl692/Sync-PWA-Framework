/**
 * BlobRelay (spec 004, R-1): stores blob ciphertext for the devices that talk to a RelayHub. It has no keys and decodes
 * nothing: it checks structure only (the manifest hashes to the blob ID, every chunk matches its digest), enforces size
 * caps, and treats what it stores as a cache (research R-08): blobs expire after an idle period, and the least recently
 * used go first when a cap is reached. Devices that still hold a blob re-offer it when they find the relay lacks it.
 *
 * Upload is "offer, the relay pulls": it sends `get` to the offerer for what it lacks, like any other holder would.
 */

import {
  chunkCount,
  decodeLaneMessage,
  decodeManifest,
  encodeLaneMessage,
  hex,
  manifestId,
  verifyChunk,
  type BlobStorage,
  type LaneMsg,
  type LaneRange as Range,
  type Manifest,
} from '@sync/blobs';
import type { RelayHub } from './relayHub';

const LANE = 0xb1;
const DAY = 24 * 60 * 60 * 1000;
const MAX_PENDING_RANGES = 256;
const MAX_PULLS_PER_PEER = 16;

export interface BlobRelayOptions {
  /** Where blobs live, for example `createFileBlobStorage(dir)`. */
  storage: BlobStorage;
  /** Largest single blob. Default 1 GiB. */
  maxBlobBytes?: number;
  /** Cap on the ciphertext held for one Space. Default: none. */
  perSpaceBytes?: number;
  /** Cap on all ciphertext held. Default: none. */
  totalBytes?: number;
  /** A blob nobody has asked for or offered for this long is deleted. Default 90 days. */
  ttlMs?: number;
  /** Return false to refuse a peer storing blobs in a Space. Default: any peer that declared the Space. */
  authorize?: (space: string, peerId: string) => boolean | Promise<boolean>;
  /** Chunks pulled from an offerer at a time. Default 8. */
  window?: number;
  /** An error while handling a lane message (a disk failure, say). Default: a console warning. The relay carries on. */
  onError?: (err: unknown) => void;
  now?: () => number;
}

interface Pull {
  peer: string;
  id: string;
  space: string;
  size: number;
  n: number;
  manifest?: Manifest;
  requested: Set<number>;
  have: Set<number>;
}

const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));

export class BlobRelay {
  private readonly o: Required<Omit<BlobRelayOptions, 'authorize' | 'onError'>> & Pick<BlobRelayOptions, 'authorize'> & { onError: (err: unknown) => void };
  private pulls = new Map<string, Pull>();
  private tails = new Map<string, Promise<void>>();
  private serving = new Map<string, { pending: number; cancelled: Set<string> }>();
  private sweeper: ReturnType<typeof setInterval>;
  private offGone: () => void;

  constructor(
    private readonly hub: RelayHub,
    opts: BlobRelayOptions,
  ) {
    this.o = {
      storage: opts.storage,
      maxBlobBytes: opts.maxBlobBytes ?? 1024 ** 3,
      perSpaceBytes: opts.perSpaceBytes ?? Infinity,
      totalBytes: opts.totalBytes ?? Infinity,
      ttlMs: opts.ttlMs ?? 90 * DAY,
      authorize: opts.authorize,
      window: opts.window ?? 8,
      onError: opts.onError ?? ((err) => console.warn('blob relay:', err)),
      now: opts.now ?? (() => Date.now()),
    };
    hub.onLane(LANE, (peer, bytes) => this.enqueue(peer, () => this.handle(peer, bytes)));
    this.offGone = hub.onLanePeerGone((peer) => {
      for (const k of [...this.pulls.keys()]) if (k.startsWith(`${peer}\u0000`)) this.pulls.delete(k);
      this.serving.delete(peer);
      this.tails.delete(peer);
    });
    this.sweeper = setInterval(() => void this.sweep().catch(() => undefined), 60 * 60 * 1000);
    (this.sweeper as { unref?: () => void }).unref?.();
  }

  close(): void {
    clearInterval(this.sweeper);
    this.offGone();
  }

  private send(peer: string, m: LaneMsg): void {
    this.hub.sendLane(peer, encodeLaneMessage(m));
  }

  private enqueue(peer: string, fn: () => Promise<void>): void {
    const tail = (this.tails.get(peer) ?? Promise.resolve()).then(fn).catch((err) => this.o.onError(err));
    this.tails.set(peer, tail);
  }

  private async handle(peer: string, bytes: Uint8Array): Promise<void> {
    const d = decodeLaneMessage(bytes);
    if (!d.ok || 'unknown' in d) return;
    const m = d.msg;
    switch (m.type) {
      case 'hello':
        return this.send(peer, { type: 'hello', v: 1, window: this.o.window, maxChunks: 4096, serve: true });
      case 'offer':
        return this.onOffer(peer, m);
      case 'manifest':
        return this.onManifest(peer, m);
      case 'chunk':
        return this.onChunk(peer, m);
      case 'miss':
        this.pulls.delete(`${peer}\u0000${m.id}`);
        return;
      case 'get':
        return this.onGet(peer, m);
      case 'cancel': {
        this.serving.get(peer)?.cancelled.add(m.id);
        return;
      }
      default:
        return; // stored and reject from a device need no action here
    }
  }

  // ---- upload: offer, then the relay pulls ----

  private async allowed(peer: string, space: string): Promise<boolean> {
    if (!this.hub.peerSpaces(peer).has(space)) return false;
    return (await this.o.authorize?.(space, peer)) !== false;
  }

  private async onOffer(peer: string, m: Extract<LaneMsg, { type: 'offer' }>): Promise<void> {
    if (!(await this.allowed(peer, m.space))) return this.send(peer, { type: 'reject', id: m.id, reason: 'space' });
    if (m.size > this.o.maxBlobBytes) return this.send(peer, { type: 'reject', id: m.id, reason: 'too-large' });
    const have = await this.o.storage.getBlob(m.id);
    if (have?.complete) {
      await this.o.storage.putBlob({ ...have, lastAccessAt: this.o.now() });
      return this.send(peer, { type: 'stored', id: m.id });
    }
    if (this.pulls.has(`${peer}\u0000${m.id}`)) return;
    if ([...this.pulls.keys()].filter((k) => k.startsWith(`${peer}\u0000`)).length >= MAX_PULLS_PER_PEER) return this.send(peer, { type: 'reject', id: m.id, reason: 'busy' });
    // room for it? evict the least recently used first; refuse only if that is not enough
    if (!(await this.makeRoom(m.space, m.size))) return this.send(peer, { type: 'reject', id: m.id, reason: 'quota' });

    const n = Math.ceil(m.size / 262144);
    const pull: Pull = { peer, id: m.id, space: m.space, size: m.size, n, requested: new Set(), have: new Set(await this.o.storage.presentChunks(m.id)) };
    if (have?.manifest) {
      const dm = decodeManifest(have.manifest, { maxBlobBytes: this.o.maxBlobBytes });
      if (dm.ok && (await manifestId(have.manifest)) === m.id) pull.manifest = dm.manifest;
    }
    this.pulls.set(`${peer}\u0000${m.id}`, pull);
    this.requestMore(pull, !pull.manifest);
  }

  private requestMore(p: Pull, withManifest: boolean): void {
    const free = this.o.window - p.requested.size;
    const want: number[] = [];
    for (let i = 0; i < p.n && want.length < free; i++) if (!p.have.has(i) && !p.requested.has(i)) want.push(i);
    if (!want.length && !withManifest) return;
    for (const i of want) p.requested.add(i);
    const ranges: Range[] = [];
    for (const i of want) {
      const last = ranges[ranges.length - 1];
      if (last && i === last[1] + 1) last[1] = i;
      else ranges.push([i, i]);
    }
    this.send(p.peer, { type: 'get', id: p.id, manifest: withManifest, space: p.space, ranges });
  }

  private async onManifest(peer: string, m: Extract<LaneMsg, { type: 'manifest' }>): Promise<void> {
    const p = this.pulls.get(`${peer}\u0000${m.id}`);
    if (!p || p.manifest) return;
    const d = decodeManifest(m.manifest, { maxBlobBytes: this.o.maxBlobBytes });
    if (!d.ok || (await manifestId(m.manifest)) !== p.id || d.manifest.size !== p.size) {
      this.pulls.delete(`${peer}\u0000${m.id}`);
      return this.send(peer, { type: 'reject', id: m.id, reason: 'unsupported' });
    }
    p.manifest = d.manifest;
    const now = this.o.now();
    await this.o.storage.putBlob({
      id: p.id,
      manifest: m.manifest,
      space: p.space,
      scope: hex(d.manifest.scopeId), // the relay cannot name the scope: it has no keys and sees only the raw ID
      keyId: hex(d.manifest.keyId),
      size: p.size,
      type: 'application/octet-stream',
      origin: 'remote',
      replicas: [],
      pinned: false,
      complete: false,
      createdAt: now,
      lastAccessAt: now,
      unreferencedAt: null,
    });
    this.requestMore(p, false);
  }

  private async onChunk(peer: string, m: Extract<LaneMsg, { type: 'chunk' }>): Promise<void> {
    const p = this.pulls.get(`${peer}\u0000${m.id}`);
    if (!p || !p.requested.delete(m.index)) return; // unsolicited
    if (!p.manifest) return;
    const v = await verifyChunk(p.manifest, m.index, m.stored);
    if (!v.ok) {
      this.pulls.delete(`${peer}\u0000${m.id}`); // a peer that sends a bad chunk is not worth pulling from
      return this.send(peer, { type: 'reject', id: m.id, reason: 'unsupported' });
    }
    await this.o.storage.putChunk(p.id, m.index, m.stored);
    p.have.add(m.index);
    if (p.have.size < chunkCount(p.size)) return this.requestMore(p, false);
    const rec = await this.o.storage.getBlob(p.id);
    if (rec) await this.o.storage.putBlob({ ...rec, complete: true, lastAccessAt: this.o.now() });
    this.pulls.delete(`${peer}\u0000${m.id}`);
    this.send(peer, { type: 'stored', id: p.id });
  }

  // ---- download: serve like any holder ----

  private async onGet(peer: string, m: Extract<LaneMsg, { type: 'get' }>): Promise<void> {
    if (!(await this.allowed(peer, m.space))) return this.send(peer, { type: 'reject', id: m.id, reason: 'space' });
    let s = this.serving.get(peer);
    if (!s) this.serving.set(peer, (s = { pending: 0, cancelled: new Set() }));
    if (s.pending + m.ranges.length > MAX_PENDING_RANGES) return this.send(peer, { type: 'reject', id: m.id, reason: 'busy' });
    s.pending += m.ranges.length;
    s.cancelled.delete(m.id);
    try {
      const rec = await this.o.storage.getBlob(m.id);
      if (!rec) return this.send(peer, { type: 'miss', id: m.id, ranges: m.ranges });
      if (m.manifest) this.send(peer, { type: 'manifest', id: m.id, manifest: rec.manifest });
      const n = chunkCount(rec.size);
      const missing: Range[] = [];
      for (const [lo, hi] of m.ranges) {
        if (hi >= n) missing.push([Math.max(lo, n), hi]); // past the end of the blob: a miss, never iterated
        for (let i = lo; i <= Math.min(hi, n - 1); i++) {
          if (s.cancelled.has(m.id)) return;
          const stored = await this.o.storage.getChunk(m.id, i);
          if (!stored) {
            const last = missing[missing.length - 1];
            if (last && i === last[1] + 1) last[1] = i;
            else missing.push([i, i]);
            continue;
          }
          this.send(peer, { type: 'chunk', id: m.id, index: i, stored });
          await yieldNow();
        }
      }
      if (missing.length) this.send(peer, { type: 'miss', id: m.id, ranges: missing });
      await this.o.storage.putBlob({ ...rec, lastAccessAt: this.o.now() });
    } finally {
      s.pending -= m.ranges.length;
      s.cancelled.delete(m.id);
    }
  }

  // ---- retention: a cache, not an archive ----

  /** Delete what nobody used for `ttlMs`. */
  async sweep(): Promise<number> {
    let n = 0;
    const cutoff = this.o.now() - this.o.ttlMs;
    for await (const b of this.o.storage.listBlobs({ orderBy: 'lastAccessAt' })) {
      if (b.lastAccessAt >= cutoff) break;
      await this.o.storage.deleteBlob(b.id);
      n++;
    }
    return n;
  }

  /** Make room for `size` more bytes in `space`, evicting the least recently used first. False if the caps cannot be met. */
  private async makeRoom(space: string, size: number): Promise<boolean> {
    if (size > this.o.totalBytes || size > this.o.perSpaceBytes) return false;
    await this.sweep();
    const all: Array<{ id: string; space: string; size: number }> = [];
    for await (const b of this.o.storage.listBlobs({ orderBy: 'lastAccessAt' })) {
      if (!this.pulls.size || ![...this.pulls.values()].some((p) => p.id === b.id)) all.push({ id: b.id, space: b.space, size: b.size });
    }
    const bytes = (f: (b: { space: string }) => boolean) => all.filter(f).reduce((a, b) => a + b.size, 0);
    for (const b of all) {
      const total = bytes(() => true) + size;
      const inSpace = bytes((x) => x.space === space) + size;
      if (total <= this.o.totalBytes && inSpace <= this.o.perSpaceBytes) return true;
      const overTotal = total > this.o.totalBytes;
      const overSpace = inSpace > this.o.perSpaceBytes;
      if ((overSpace && b.space === space) || (overTotal && !overSpace) || (overTotal && overSpace)) {
        await this.o.storage.deleteBlob(b.id);
        all.splice(all.indexOf(b), 1);
      }
    }
    return bytes(() => true) + size <= this.o.totalBytes && bytes((x) => x.space === space) + size <= this.o.perSpaceBytes;
  }
}
