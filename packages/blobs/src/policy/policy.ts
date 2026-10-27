/**
 * What stays on this device (FR-009, research R-10): an optional storage budget with least-recently-used eviction, and
 * device-local pins. Pins, budgets and replica beliefs are never synced.
 *
 * Eviction removes a blob's chunks and keeps its record and manifest, so fetching it again needs no manifest round trip.
 * It never touches a blob that is pinned, has fewer than `minReplicas` confirmed copies elsewhere (so the only known
 * copy cannot be lost), is open in a stream, or is being downloaded.
 */

import { NONCE_BYTES, TAG_BYTES } from '../format/constants';
import { chunkCount } from '../format/manifest';
import { validateRef, type BlobRef } from '../format/ref';
import type { Engine } from '../engine';
import type { StoredBlob } from '../types';

const SLICE = 50;
const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));

/** Ciphertext bytes a complete blob occupies in storage. */
export const storedBytes = (size: number): number => size + chunkCount(size) * (NONCE_BYTES + TAG_BYTES);

export class Policy {
  private running: Promise<number> | undefined;
  private off: (() => void) | undefined;

  constructor(private readonly e: Engine) {}

  start(): void {
    // The core reports pressure on the packet database; with a budget set, blobs give way too.
    this.off = this.e.core.on((ev) => {
      if (ev.kind === 'storage:pressure' && this.e.cfg.budgetBytes !== undefined) void this.evict().catch(() => undefined);
    });
  }

  stop(): void {
    this.off?.();
  }

  // ---- pins ----

  async pin(ref: BlobRef): Promise<void> {
    const v = validateRef(ref, { maxBlobBytes: this.e.cfg.maxBlobBytes });
    if (!v.ok) throw new TypeError(`not a usable blob reference: ${v.reason}`);
    let rec = await this.e.storage.getBlob(ref.id);
    if (!rec?.complete) {
      await this.e.scheduler.request(ref); // "keep it offline" means having it
      rec = await this.e.storage.getBlob(ref.id);
    }
    if (!rec) return;
    await this.e.storage.putBlob({ ...rec, pinned: true });
    this.e.status.update(ref.id, { pinned: true }, ref.size);
  }

  async unpin(ref: BlobRef): Promise<void> {
    const rec = await this.e.storage.getBlob(ref.id);
    if (!rec) return;
    await this.e.storage.putBlob({ ...rec, pinned: false });
    this.e.status.update(ref.id, { pinned: false }, ref.size);
    void this.evict().catch(() => undefined); // it may have been the reason the budget was exceeded
  }

  // ---- usage ----

  async usage(): Promise<{ usedBytes: number; blobs: number; pinnedBytes: number; unreplicatedBytes: number }> {
    let blobs = 0;
    let pinnedBytes = 0;
    let unreplicatedBytes = 0;
    for await (const rec of this.e.storage.listBlobs()) {
      if (!rec.complete) continue;
      blobs++;
      const bytes = storedBytes(rec.size);
      if (rec.pinned) pinnedBytes += bytes;
      if (rec.replicas.length < this.e.cfg.minReplicas) unreplicatedBytes += bytes;
    }
    return { usedBytes: await this.e.storage.usedBytes(), blobs, pinnedBytes, unreplicatedBytes };
  }

  // ---- eviction ----

  private evictable(rec: StoredBlob): boolean {
    return (
      !!rec.complete &&
      !rec.pinned &&
      rec.replicas.length >= this.e.cfg.minReplicas &&
      !this.e.leases.has(rec.id) &&
      !this.e.scheduler.wants(rec.id)
    );
  }

  /**
   * Evict least-recently-used blobs until stored bytes are at or under `targetBytes` (default: the budget; with neither,
   * nothing is evicted). Returns the bytes freed. Concurrent calls share one run.
   */
  evict(opts: { targetBytes?: number } = {}): Promise<number> {
    const target = opts.targetBytes ?? this.e.cfg.budgetBytes;
    if (target === undefined) return Promise.resolve(0);
    return (this.running ??= this.run(target).finally(() => (this.running = undefined)));
  }

  /** Free at least `bytes` (a quota error with `evictOnQuota`): evict regardless of the budget. Returns the bytes freed. */
  async freeFor(bytes: number): Promise<number> {
    const before = await this.e.storage.usedBytes();
    return this.run(Math.max(0, before - bytes));
  }

  private async run(target: number): Promise<number> {
    let used = await this.e.storage.usedBytes();
    let freed = 0;
    if (used > target) {
      const candidates: StoredBlob[] = [];
      let seen = 0;
      for await (const rec of this.e.storage.listBlobs({ orderBy: 'lastAccessAt' })) {
        if (++seen % SLICE === 0) await yieldNow();
        if (this.evictable(rec)) candidates.push(rec);
      }
      for (const rec of candidates) {
        if (used <= target || this.e.closed) break;
        if (!this.evictable(rec)) continue; // it became busy meanwhile
        const bytes = await this.e.storage.deleteChunks(rec.id);
        await this.e.storage.putBlob({ ...rec, complete: false });
        used -= bytes;
        freed += bytes;
        this.e.status.update(rec.id, { state: 'missing', reason: 'evicted', progress: 0, bytesDone: 0 }, rec.size);
        this.e.events.emit('blob:evicted', { id: rec.id, bytes });
      }
    }
    if (freed > 0 || (this.e.cfg.budgetBytes !== undefined && used > this.e.cfg.budgetBytes)) {
      this.e.events.emit('blob:storage', { usedBytes: used, budgetBytes: this.e.cfg.budgetBytes });
    }
    return freed;
  }
}
