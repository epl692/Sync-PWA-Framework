/**
 * Garbage collection of blobs nothing refers to (FR-008). A blob whose last reference went is deleted `retentionMs`
 * later (default 30 days, the history window, so undo can still bring the object back). A blob that was never
 * referenced (an attach whose object was never created) goes after `orphanGraceMs` (default 24 hours). Work runs in
 * slices so it never holds the page.
 */

import type { Engine } from '../engine';
import type { RefIndex } from './index';

const SLICE = 50;
const INTERVAL_MS = 60 * 60 * 1000;
const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));

export class Gc {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<number> | undefined;

  constructor(
    private readonly e: Engine,
    private readonly refs: RefIndex,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.collect().catch(() => undefined), INTERVAL_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Delete what is due. Returns how many blobs went. Concurrent calls share one run. */
  collect(): Promise<number> {
    return (this.running ??= this.run().finally(() => (this.running = undefined)));
  }

  private async run(): Promise<number> {
    const { cfg } = this.e;
    const now = this.e.now();
    const due: Array<{ id: string; reason: 'unreferenced' | 'orphan' }> = [];
    let seen = 0;
    for await (const rec of this.e.storage.listBlobs({ orderBy: 'createdAt' })) {
      if (++seen % SLICE === 0) await yieldNow();
      if (this.e.closed) break;
      if (this.e.leases.has(rec.id) || this.e.scheduler.wants(rec.id) || this.refs.isReferenced(rec.id)) continue;
      const clock = rec.unreferencedAt ?? rec.createdAt;
      const limit = rec.unreferencedAt === null ? cfg.orphanGraceMs : cfg.retentionMs;
      if (now - clock > limit) due.push({ id: rec.id, reason: rec.unreferencedAt === null ? 'orphan' : 'unreferenced' });
    }
    for (const [i, d] of due.entries()) {
      if (i && i % SLICE === 0) await yieldNow();
      await this.e.storage.deleteBlob(d.id);
      this.e.status.update(d.id, { state: 'missing', reason: 'not-requested', progress: 0, bytesDone: 0, pinned: false, replicas: 0 });
      this.e.events.emit('blob:deleted', d);
    }
    return due.length;
  }
}
