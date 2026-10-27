/**
 * The reference index (research R-09): which objects hold which blob references. It is derived state, never
 * authoritative: it follows the core's applied packets (reading the object after the packet, because a last-writer-wins
 * loser changes nothing) and can be rebuilt from the objects at any time.
 *
 * An object holds a reference only while it is visible: a deleted (or hidden) object holds none, which starts the
 * blob's retention clock (`unreferencedAt`); undo or an edit that brings the object back clears it again.
 *
 * Persisted as one small record in `meta` (object → blob IDs), plus a per-blob mirror (`getRefs`) for blobs held here.
 */

import type { Engine } from '../engine';
import { refsIn } from './watch';

const META = 'refs:index';
/** Bump when the stored shape changes: the index is then rebuilt from the objects. */
export const REFS_VERSION = 1;
const SAVE_DELAY_MS = 400;

interface Saved {
  version: number;
  objects: Record<string, string[]>;
}

export class RefIndex {
  private objects = new Map<string, Set<string>>();
  private blobs = new Map<string, Set<string>>();
  private tail: Promise<void> = Promise.resolve();
  private off: (() => void) | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;

  constructor(private readonly e: Engine) {}

  async start(): Promise<void> {
    const saved = await this.e.storage.getMeta<Saved>(META);
    if (saved?.version === REFS_VERSION) {
      for (const [obj, ids] of Object.entries(saved.objects)) this.set(obj, new Set(ids));
    } else {
      await this.reindex();
    }
    this.off = this.e.core.onApplied(({ object }) => {
      if (object && !this.e.closed) this.enqueue(() => this.follow(object.id));
    });
  }

  async stop(): Promise<void> {
    this.off?.();
    await this.tail;
    await this.flush();
  }

  isReferenced(blobId: string): boolean {
    return (this.blobs.get(blobId)?.size ?? 0) > 0;
  }

  /** Make the stored mirror and `unreferencedAt` of a blob agree with the index (after its record was created). */
  async sync(blobId: string): Promise<void> {
    await this.touch(blobId);
  }

  /** Rebuild from the objects the core can see. Blobs that lose their last reference this way start their clock now. */
  async reindex(): Promise<void> {
    const rows = await this.e.core.query({}).once();
    const before = new Set(this.blobs.keys());
    this.objects.clear();
    this.blobs.clear();
    for (const row of rows) {
      const ids = new Set(refsIn(row.fields, this.e.cfg.maxBlobBytes).map((r) => r.id));
      if (ids.size) this.set(row.id, ids);
    }
    const all = new Set([...before, ...this.blobs.keys()]);
    for await (const rec of this.e.storage.listBlobs()) all.add(rec.id);
    for (const id of all) await this.touch(id, before.has(id) && !this.blobs.has(id));
    this.markDirty();
    await this.flush();
  }

  // ---- internals ----

  private enqueue(fn: () => Promise<void>): void {
    this.tail = this.tail.then(fn).catch(() => undefined);
  }

  private set(obj: string, ids: Set<string>): void {
    const old = this.objects.get(obj) ?? new Set<string>();
    for (const id of old) if (!ids.has(id)) this.blobs.get(id)?.delete(obj);
    for (const id of ids) {
      let s = this.blobs.get(id);
      if (!s) this.blobs.set(id, (s = new Set()));
      s.add(obj);
    }
    if (ids.size) this.objects.set(obj, ids);
    else this.objects.delete(obj);
    for (const id of old) if (!this.blobs.get(id)?.size) this.blobs.delete(id);
  }

  /** The object's references now: its fields if it is visible, none if it is deleted or hidden. */
  private async follow(objectId: string): Promise<void> {
    const now = await this.e.core.get(objectId);
    const next = new Set(now ? refsIn(now.fields, this.e.cfg.maxBlobBytes).map((r) => r.id) : []);
    const old = this.objects.get(objectId) ?? new Set<string>();
    const changed = [...next].filter((i) => !old.has(i)).concat([...old].filter((i) => !next.has(i)));
    if (!changed.length) return;
    this.set(objectId, next);
    for (const id of changed) await this.touch(id, true);
    this.markDirty();
  }

  /** `lost`: a reference was just removed, so a blob left with none starts its retention clock now. A blob that was never referenced keeps the orphan rule (its age). */
  private async touch(blobId: string, lost = false): Promise<void> {
    const rec = await this.e.storage.getBlob(blobId);
    if (!rec) return;
    const refs = [...(this.blobs.get(blobId) ?? [])].sort();
    await this.e.storage.setRefs(blobId, refs);
    const unreferencedAt = refs.length ? null : lost ? (rec.unreferencedAt ?? this.e.now()) : rec.unreferencedAt;
    if (unreferencedAt !== rec.unreferencedAt) await this.e.storage.putBlob({ ...rec, unreferencedAt });
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush().catch(() => undefined);
    }, SAVE_DELAY_MS);
    (this.saveTimer as { unref?: () => void }).unref?.();
  }

  private async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (!this.dirty) return;
    this.dirty = false;
    const objects: Record<string, string[]> = {};
    for (const [obj, ids] of this.objects) objects[obj] = [...ids];
    await this.e.storage.setMeta<Saved>(META, { version: REFS_VERSION, objects });
  }
}
