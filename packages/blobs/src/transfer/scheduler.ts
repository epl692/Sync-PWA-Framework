/**
 * Fetching (research R-06): one `Transfer` per blob being downloaded. A transfer asks up to `maxSources` peers that
 * sync the blob's Space for ranges of chunks, keeps at most a window of chunks outstanding per peer, verifies every
 * chunk before storing it, re-asks another source when one fails, and resumes by asking only for the chunks that are
 * not stored yet. With no source it parks as `missing / no-source` and continues when a holder shows up.
 */

import { StorageQuotaError } from '@sync/core';
import { windowFor } from '../config';
import type { Engine } from '../engine';
import { chunkCount, plainLength, type Manifest } from '../format/manifest';
import { validateRef, type BlobRef } from '../format/ref';
import type { LaneMsg, Range } from '../protocol/codec';
import { BlobFetchError, type BlobFailure, type StoredBlob } from '../types';
import { verifyChunk, verifyManifest } from './verify';

const MAX_RANGES_PER_GET = 256;
const STRIKES = 3;
const BACKOFF_MS = 200;
const STASH_MAX = 64;

interface PeerFetch {
  /** Chunk indexes asked of this peer and not yet answered, with when they were asked. */
  requested: Map<number, number>;
  /** Indexes this peer said it does not have. */
  misses: Set<number>;
  excluded: boolean;
  manifestAsked: boolean;
  manifestAt: number;
  /** After a failed verification this peer is not asked again until then (others are asked at once). */
  retryAt: number;
}

interface Waiter {
  resolve(): void;
  reject(e: Error): void;
}

interface Transfer {
  id: string;
  ref: BlobRef;
  n: number;
  manifestBytes?: Uint8Array;
  manifest?: Manifest;
  have: Set<number>;
  bytesDone: number;
  peers: Map<string, PeerFetch>;
  /** Peers that offered this blob: asked first. */
  offerers: Set<string>;
  /** Peers that delivered chunks: told `stored` at the end. */
  served: Set<string>;
  waiters: Waiter[];
  priority: number;
  state: 'running' | 'parked' | 'done' | 'failed';
  /** Chunk indexes being verified or stored right now: not asked for again meanwhile. */
  processing: Set<number>;
  /** Chunks that arrived before the manifest, verified once it is known. */
  stash: Map<number, { peer: string; stored: Uint8Array }>;
  retry?: ReturnType<typeof setTimeout>;
}

const PRIORITY = { high: 2, normal: 1, low: 0 } as const;
const isQuota = (e: unknown) => e instanceof StorageQuotaError || (e as { code?: string })?.code === 'storage-quota';

export function coalesce(indexes: number[]): Range[] {
  const sorted = [...indexes].sort((a, b) => a - b);
  const out: Range[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i === last[1] + 1) last[1] = i;
    else if (!last || i > last[1]) out.push([i, i]);
  }
  return out;
}

export class Scheduler {
  private transfers = new Map<string, Transfer>();
  private starting = new Map<string, Promise<Transfer>>();
  /** Blobs whose ciphertext is complete here but whose epoch key this device does not hold (yet). */
  private noKey = new Map<string, { scope: string; keyId: string; size: number }>();
  private sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly e: Engine) {
    this.sweeper = setInterval(() => this.sweep(), Math.max(50, Math.min(2000, e.cfg.requestTimeoutMs / 4)));
    (this.sweeper as { unref?: () => void }).unref?.();
    e.keys.onKeysChanged(() => void this.recheckKeys());
  }

  close(): void {
    clearInterval(this.sweeper);
    for (const t of this.transfers.values()) {
      clearTimeout(t.retry);
      this.fail(t, 'cancelled', false);
    }
  }

  /** Is this blob being downloaded (so an incoming offer of it is wanted)? */
  wants(id: string): boolean {
    const t = this.transfers.get(id);
    return !!t && (t.state === 'running' || t.state === 'parked');
  }

  // ---- requests ----

  async request(ref: BlobRef, opts: { priority?: 'high' | 'normal' | 'low'; signal?: AbortSignal } = {}): Promise<void> {
    const v = validateRef(ref, { maxBlobBytes: this.e.cfg.maxBlobBytes });
    if (!v.ok) throw new TypeError(`not a usable blob reference: ${v.reason}`);
    opts.signal?.throwIfAborted();
    const rec = await this.e.storage.getBlob(ref.id);
    if (rec?.complete) return this.finishLocal(rec, ref);

    let t = this.transfers.get(ref.id);
    if (!t || t.state === 'failed' || t.state === 'done') {
      let s = this.starting.get(ref.id);
      if (!s) {
        s = this.start(ref, rec).finally(() => this.starting.delete(ref.id));
        this.starting.set(ref.id, s);
      }
      t = await s;
    }
    t.priority = Math.max(t.priority, PRIORITY[opts.priority ?? 'normal']);
    return new Promise<void>((resolve, reject) => {
      if (t.state === 'done') return resolve();
      const waiter: Waiter = { resolve, reject };
      t.waiters.push(waiter);
      opts.signal?.addEventListener(
        'abort',
        () => {
          t.waiters = t.waiters.filter((w) => w !== waiter);
          reject(opts.signal!.reason ?? new BlobFetchError('cancelled'));
          if (!t.waiters.length && t.state !== 'done') this.cancel(ref.id);
        },
        { once: true },
      );
      this.pumpAll();
    });
  }

  /** The record says complete: make the status honest about the key, then resolve or reject. */
  private async finishLocal(rec: StoredBlob, ref: BlobRef): Promise<void> {
    await this.e.storage.putBlob({ ...rec, lastAccessAt: this.e.now(), unreferencedAt: null });
    if (!(await this.e.keys.forRead(rec.scope, rec.keyId))) {
      this.markNoKey(rec.id, rec.scope, rec.keyId, rec.size);
      throw new BlobFetchError('no-key');
    }
    this.e.status.fromRecord({ ...rec, size: ref.size });
  }

  private async start(ref: BlobRef, rec: StoredBlob | undefined): Promise<Transfer> {
    const have = new Set(await this.e.storage.presentChunks(ref.id));
    const n = chunkCount(ref.size);
    const t: Transfer = {
      id: ref.id,
      ref,
      n,
      have,
      bytesDone: 0,
      peers: new Map(),
      offerers: new Set(),
      served: new Set(),
      waiters: [],
      priority: 0,
      state: 'running',
      processing: new Set(),
      stash: new Map(),
    };
    for (const i of have) t.bytesDone += plainLength(ref.size, i);
    if (rec?.manifest) {
      const v = await verifyManifest(ref, rec.manifest, { maxBlobBytes: this.e.cfg.maxBlobBytes });
      if (v.ok) {
        t.manifestBytes = rec.manifest;
        t.manifest = v.manifest;
      } else {
        // a stored manifest that no longer verifies is dropped with its chunks: start clean
        await this.e.storage.deleteChunks(ref.id);
        have.clear();
        t.bytesDone = 0;
      }
    } else if (have.size) {
      await this.e.storage.deleteChunks(ref.id); // chunks without a verified manifest cannot be trusted
      have.clear();
      t.bytesDone = 0;
    }
    this.transfers.set(ref.id, t);
    this.progress(t);
    if (t.manifest && have.size === n) await this.finalize(t);
    return t;
  }

  cancel(id: string): void {
    const t = this.transfers.get(id);
    if (!t || t.state === 'done' || t.state === 'failed') return;
    for (const [peer, pf] of t.peers) if (pf.requested.size) void this.e.peers.send(peer, { type: 'cancel', id });
    this.fail(t, 'cancelled', true);
  }

  // ---- inbound ----

  /** A holder offered a blob we are waiting for. */
  onOffer(peer: string, m: Extract<LaneMsg, { type: 'offer' }>): void {
    const t = this.transfers.get(m.id);
    if (!t || t.state === 'done' || t.state === 'failed') return;
    t.offerers.add(peer);
    t.peers.get(peer)?.misses.clear();
    if (t.state === 'parked') t.state = 'running';
    this.pumpAll();
  }

  onPeerReady(peer: string): void {
    for (const t of this.transfers.values()) {
      t.peers.get(peer)?.misses.clear();
      if (t.state === 'parked') t.state = 'running';
    }
    this.pumpAll();
  }

  onPeerGone(peer: string): void {
    for (const t of this.transfers.values()) t.peers.delete(peer);
    this.pumpAll();
  }

  async onManifest(peer: string, m: Extract<LaneMsg, { type: 'manifest' }>): Promise<void> {
    const t = this.transfers.get(m.id);
    if (!t || t.manifest || t.state === 'done' || t.state === 'failed') return;
    const keys = await this.e.keys.forRead(t.ref.scope, t.ref.keyId);
    const v = await verifyManifest(t.ref, m.manifest, { maxBlobBytes: this.e.cfg.maxBlobBytes, scopeId: keys?.scopeId });
    if (t.manifest) return;
    if (!v.ok) {
      const pf = t.peers.get(peer);
      if (pf) pf.manifestAsked = false; // ask again, from this peer after the back-off or from another at once
      return this.strike(t, peer, v.reason);
    }
    t.manifestBytes = m.manifest;
    t.manifest = v.manifest;
    const now = this.e.now();
    const existing = await this.e.storage.getBlob(t.id);
    if (!existing) {
      await this.e.storage.putBlob({
        id: t.id,
        manifest: m.manifest,
        space: t.ref.space,
        scope: t.ref.scope,
        keyId: t.ref.keyId,
        size: t.ref.size,
        type: t.ref.type,
        origin: 'remote',
        replicas: [],
        pinned: false,
        complete: false,
        createdAt: now,
        lastAccessAt: now,
        unreferencedAt: null,
      });
      await this.e.refs.sync(t.id);
    }
    const stash = [...t.stash];
    t.stash.clear();
    for (const [index] of stash) t.processing.add(index); // still being handled: never asked for again meanwhile
    for (const [index, s] of stash) await this.accept(t, s.peer, index, s.stored);
    for (const [index] of stash) t.processing.delete(index);
    this.pumpAll();
  }

  async onChunk(peer: string, m: Extract<LaneMsg, { type: 'chunk' }>): Promise<void> {
    const t = this.transfers.get(m.id);
    if (!t || t.state === 'done' || t.state === 'failed') return;
    const pf = t.peers.get(peer);
    if (!pf || !pf.requested.delete(m.index)) return; // unsolicited, duplicated or late: ignored
    if (!t.manifest) {
      if (t.stash.size < STASH_MAX) t.stash.set(m.index, { peer, stored: m.stored });
      return;
    }
    await this.accept(t, peer, m.index, m.stored);
  }

  onMiss(peer: string, m: Extract<LaneMsg, { type: 'miss' }>): void {
    const t = this.transfers.get(m.id);
    const pf = t?.peers.get(peer);
    if (!t || !pf) return;
    for (const [lo, hi] of m.ranges) {
      for (let i = lo; i <= Math.min(hi, t.n - 1); i++) {
        pf.requested.delete(i);
        pf.misses.add(i);
      }
    }
    this.pumpAll();
  }

  /** `reject` in answer to a get: this peer will not serve the blob (now). */
  onReject(peer: string, id: string, reason: string): void {
    const t = this.transfers.get(id);
    const pf = t?.peers.get(peer);
    if (!t || !pf) return;
    pf.requested.clear();
    if (reason === 'busy') {
      clearTimeout(t.retry);
      t.retry = setTimeout(() => this.pumpAll(), 500);
    } else {
      pf.excluded = true;
    }
    this.pumpAll();
  }

  // ---- verification and storage ----

  private async accept(t: Transfer, peer: string, index: number, stored: Uint8Array): Promise<void> {
    if (t.have.has(index) || !t.manifest) return;
    t.processing.add(index);
    try {
      await this.verifyAndStore(t, peer, index, stored);
    } finally {
      t.processing.delete(index);
    }
    if (t.state === 'done' || t.state === 'failed') return;
    if (t.have.size === t.n) await this.finalize(t);
    else this.pumpAll();
  }

  private async verifyAndStore(t: Transfer, peer: string, index: number, stored: Uint8Array): Promise<void> {
    const v = await verifyChunk(t.manifest!, index, stored);
    if (t.state === 'done' || t.state === 'failed') return;
    if (!v.ok) return this.strike(t, peer, v.reason, index);
    try {
      await this.e.storage.putChunk(t.id, index, stored);
    } catch (err) {
      if (!isQuota(err)) return this.fail(t, 'unavailable', true);
      // out of room: with `evictOnQuota` make some (never from a pinned, unconfirmed or busy blob) and try once more
      const freed = this.e.cfg.evictOnQuota ? await this.e.policy.freeFor(stored.length) : 0;
      try {
        if (freed < stored.length) throw err;
        await this.e.storage.putChunk(t.id, index, stored);
      } catch {
        return this.fail(t, 'quota', true);
      }
    }
    if (t.have.has(index)) return;
    t.have.add(index);
    t.bytesDone += plainLength(t.ref.size, index);
    t.served.add(peer);
    this.progress(t);
  }

  /** A chunk or manifest from a peer failed verification: drop it, count it against the peer, ask elsewhere. */
  private strike(t: Transfer, peer: string, reason: string, index?: number): void {
    this.e.events.emit('blob:rejected', { id: t.id, peer, reason });
    const ps = this.e.peers.state(peer);
    const strikes = (ps?.strikes.get(t.id) ?? 0) + 1;
    ps?.strikes.set(t.id, strikes);
    const pf = t.peers.get(peer);
    if (index !== undefined) pf?.requested.delete(index);
    if (strikes >= STRIKES && pf) pf.excluded = true;
    const wait = BACKOFF_MS * strikes;
    if (pf) pf.retryAt = Date.now() + wait;
    clearTimeout(t.retry);
    t.retry = setTimeout(() => this.pumpAll(), wait);
    this.pumpAll(); // other sources are asked at once
    // every source that could serve it is excluded: nothing left to try
    if (!this.candidates(t, true).length && !this.hasOutstanding(t) && this.known(t)) this.fail(t, 'verification', true);
  }

  private async finalize(t: Transfer): Promise<void> {
    if (t.state === 'done') return;
    t.state = 'done';
    clearTimeout(t.retry);
    const rec = await this.e.storage.getBlob(t.id);
    if (rec) {
      const replicas = [...new Set([...rec.replicas, ...t.served])].slice(-16);
      await this.e.storage.putBlob({ ...rec, complete: true, replicas, lastAccessAt: this.e.now(), unreferencedAt: null });
    }
    this.transfers.delete(t.id);
    this.pumpAll(); // its window slots are free: the other transfers go on
    const keys = await this.e.keys.forRead(t.ref.scope, t.ref.keyId);
    for (const p of t.served) void this.e.peers.send(p, { type: 'stored', id: t.id });
    if (!keys) {
      this.markNoKey(t.id, t.ref.scope, t.ref.keyId, t.ref.size);
      for (const w of t.waiters.splice(0)) w.reject(new BlobFetchError('no-key'));
      return;
    }
    this.e.status.update(t.id, { state: 'available', replicas: t.served.size }, t.ref.size);
    this.e.events.emit('blob:available', { id: t.id });
    for (const w of t.waiters.splice(0)) w.resolve();
    void this.e.policy.evict().catch(() => undefined); // a finished download may push the device over its budget
    void this.e.offers.offerBlob(t.id).catch(() => undefined);
  }

  private fail(t: Transfer, reason: BlobFailure, report: boolean): void {
    if (t.state === 'done' || t.state === 'failed') return;
    t.state = 'failed';
    clearTimeout(t.retry);
    this.transfers.delete(t.id);
    this.pumpAll();
    this.e.status.update(t.id, { state: 'failed', reason }, t.ref.size);
    if (report) this.e.events.emit('blob:failed', { id: t.id, reason });
    for (const w of t.waiters.splice(0)) w.reject(new BlobFetchError(reason));
  }

  // ---- keys ----

  private markNoKey(id: string, scope: string, keyId: string, size: number): void {
    this.noKey.set(id, { scope, keyId, size });
    this.e.status.update(id, { state: 'failed', reason: 'no-key' }, size);
    this.e.events.emit('blob:failed', { id, reason: 'no-key' });
  }

  /** Called by open when decryption keys are missing for a blob that is stored complete. */
  noteNoKey(rec: StoredBlob): void {
    this.markNoKey(rec.id, rec.scope, rec.keyId, rec.size);
  }

  /** A new epoch key arrived: blobs that failed with `no-key` become available, without any download. */
  async recheckKeys(): Promise<void> {
    for (const [id, k] of [...this.noKey]) {
      if (!(await this.e.keys.forRead(k.scope, k.keyId))) continue;
      this.noKey.delete(id);
      const rec = await this.e.storage.getBlob(id);
      if (rec?.complete) {
        this.e.status.update(id, { state: 'available' }, k.size);
        this.e.events.emit('blob:available', { id });
      }
    }
  }

  // ---- scheduling ----

  private known(t: Transfer): boolean {
    return this.e.peers.ready().length > 0 || t.peers.size > 0;
  }

  private hasOutstanding(t: Transfer): boolean {
    for (const pf of t.peers.values()) if (pf.requested.size) return true;
    return false;
  }

  private outstandingTo(peer: string): number {
    let n = 0;
    for (const t of this.transfers.values()) n += t.peers.get(peer)?.requested.size ?? 0;
    return n;
  }

  /** Peers that may serve this blob: ready, syncing its Space, willing to serve, not excluded. Offerers first. */
  private candidates(t: Transfer, ignoreBackoff = false): string[] {
    const keys = this.e.peers
      .ready()
      .filter((p) => p.hello?.serve !== false && this.e.peers.shares(p.key, t.ref.space))
      .map((p) => p.key)
      .filter((k) => !t.peers.get(k)?.excluded && (this.e.peers.state(k)?.strikes.get(t.id) ?? 0) < STRIKES)
      .filter((k) => ignoreBackoff || (t.peers.get(k)?.retryAt ?? 0) <= Date.now());
    return keys.sort((a, b) => Number(t.offerers.has(b)) - Number(t.offerers.has(a)));
  }

  private pumpAll(): void {
    const order = [...this.transfers.values()].filter((t) => t.state === 'running' || t.state === 'parked').sort((a, b) => b.priority - a.priority);
    for (const t of order) this.pump(t);
  }

  private pump(t: Transfer): void {
    if (t.state !== 'running' && t.state !== 'parked') return;
    const missing: number[] = [];
    for (let i = 0; i < t.n; i++) if (!t.have.has(i)) missing.push(i);
    if (!missing.length) return;
    const asked = new Set<number>([...t.processing, ...t.stash.keys()]);
    for (const pf of t.peers.values()) for (const i of pf.requested.keys()) asked.add(i);

    const sources = this.candidates(t).slice(0, this.e.cfg.maxSources);
    let sent = 0;
    let left = sources.length;
    for (const peer of sources) {
      const info = this.e.peers.info(peer);
      const free = windowFor(this.e.cfg, info?.bulk ?? false) - this.outstandingTo(peer);
      const share = left--; // sources still to serve, this one included: the unasked chunks are split evenly
      if (free <= 0) continue;
      let pf = t.peers.get(peer);
      if (!pf) t.peers.set(peer, (pf = { requested: new Map(), misses: new Set(), excluded: false, manifestAsked: false, manifestAt: 0, retryAt: 0 }));
      const open = missing.filter((i) => !asked.has(i) && !pf!.misses.has(i));
      const pick = open.slice(0, Math.min(free, Math.ceil(open.length / share)));
      const needManifest = !t.manifest && !pf.manifestAsked;
      if (!pick.length && !needManifest) continue; // (a manifest alone is a get with no ranges)
      const ranges = coalesce(pick).slice(0, MAX_RANGES_PER_GET);
      const wanted = ranges.flatMap(([lo, hi]) => Array.from({ length: hi - lo + 1 }, (_, k) => lo + k));
      const now = Date.now();
      for (const i of wanted) {
        pf.requested.set(i, now);
        asked.add(i);
      }
      if (needManifest) {
        pf.manifestAsked = true;
        pf.manifestAt = Date.now();
      }
      sent++;
      void this.e.peers.send(peer, { type: 'get', id: t.id, manifest: needManifest, space: t.ref.space, ranges });
    }

    const outstanding = this.hasOutstanding(t);
    if (!outstanding && !sent) {
      // nothing in flight and nobody to ask: wait for a holder to appear (offer or a peer becoming ready)
      if (t.state !== 'parked' || this.e.status.get(t.id).reason !== 'no-source') {
        t.state = 'parked';
        this.e.status.update(t.id, { state: 'missing', reason: 'no-source', bytesDone: t.bytesDone, progress: t.bytesDone / t.ref.size }, t.ref.size);
      }
    } else if (t.state === 'parked') {
      t.state = 'running';
      this.progress(t);
    }
  }

  private progress(t: Transfer): void {
    this.e.status.update(t.id, { state: 'downloading', bytesDone: t.bytesDone, progress: t.bytesDone / t.ref.size, size: t.ref.size }, t.ref.size);
    this.e.events.emit('blob:progress', { id: t.id, bytesDone: t.bytesDone, size: t.ref.size });
  }

  /** Chunks asked long ago and never answered are asked again (from any source) after a short back-off. */
  private sweep(): void {
    const now = Date.now();
    let changed = false;
    for (const t of this.transfers.values()) {
      for (const pf of t.peers.values()) {
        if (!t.manifest && pf.manifestAsked && now - pf.manifestAt > this.e.cfg.requestTimeoutMs) {
          pf.manifestAsked = false; // the manifest never came: ask again
          changed = true;
        }
        for (const [i, at] of pf.requested) {
          if (now - at > this.e.cfg.requestTimeoutMs) {
            // no answer is not a "miss": the message may simply have been lost, so ask again after a short back-off
            pf.requested.delete(i);
            pf.retryAt = now + BACKOFF_MS;
            changed = true;
            clearTimeout(t.retry);
            t.retry = setTimeout(() => this.pumpAll(), BACKOFF_MS + 5);
          }
        }
      }
    }
    if (changed) this.pumpAll();
  }
}
