/** In-memory BlobStorage for tests and Node. Not persistent. */

import { StorageQuotaError } from '@sync/core';
import type { BlobStorage, StoredBlob } from '../types';

export interface MemoryBlobStorage extends BlobStorage {
  /** Test hook: chunk writes beyond this many stored bytes fail with StorageQuotaError. */
  setQuota(bytes: number | undefined): void;
}

const clone = (b: StoredBlob): StoredBlob => ({ ...b, manifest: b.manifest.slice(), replicas: [...b.replicas] });

export function createMemoryBlobStorage(opts: { quotaBytes?: number } = {}): MemoryBlobStorage {
  const blobs = new Map<string, StoredBlob>();
  const chunks = new Map<string, Map<number, Uint8Array>>();
  const refs = new Map<string, string[]>();
  const meta = new Map<string, unknown>();
  let used = 0;
  let quota = opts.quotaBytes;
  let closed = false;
  const open = () => {
    if (closed) throw new Error('blob storage is closed');
  };

  const dropChunks = (id: string): number => {
    const m = chunks.get(id);
    if (!m) return 0;
    let freed = 0;
    for (const c of m.values()) freed += c.length;
    chunks.delete(id);
    used -= freed;
    return freed;
  };

  return {
    setQuota: (b) => void (quota = b),

    async getBlob(id) {
      open();
      const b = blobs.get(id);
      return b && clone(b);
    },
    async putBlob(rec) {
      open();
      blobs.set(rec.id, clone(rec));
    },
    async *listBlobs(o) {
      open();
      const key = o?.orderBy ?? 'lastAccessAt';
      const all = [...blobs.values()].sort((a, b) => a[key] - b[key] || (a.id < b.id ? -1 : 1));
      for (const b of o?.limit !== undefined ? all.slice(0, o.limit) : all) yield clone(b);
    },
    async deleteBlob(id) {
      open();
      blobs.delete(id);
      refs.delete(id);
      dropChunks(id);
    },

    async putChunk(id, index, stored) {
      open();
      let m = chunks.get(id);
      if (m?.has(index)) return; // idempotent: identical content by construction
      if (quota !== undefined && used + stored.length > quota) throw new StorageQuotaError();
      if (!m) chunks.set(id, (m = new Map()));
      m.set(index, stored.slice());
      used += stored.length;
    },
    async getChunk(id, index) {
      open();
      return chunks.get(id)?.get(index);
    },
    async presentChunks(id) {
      open();
      return [...(chunks.get(id)?.keys() ?? [])].sort((a, b) => a - b);
    },
    async deleteChunks(id) {
      open();
      return dropChunks(id);
    },
    async moveChunks(from, to) {
      open();
      const src = chunks.get(from);
      if (!src || from === to) return;
      let dst = chunks.get(to);
      if (!dst) chunks.set(to, (dst = new Map()));
      for (const [i, c] of src) {
        if (dst.has(i)) used -= c.length; // the destination already holds it: drop the duplicate
        else dst.set(i, c);
      }
      chunks.delete(from);
    },

    async getRefs(id) {
      open();
      return [...(refs.get(id) ?? [])];
    },
    async setRefs(id, objects) {
      open();
      if (objects.length) refs.set(id, [...objects]);
      else refs.delete(id);
    },
    async getMeta<T>(key: string) {
      open();
      return meta.has(key) ? (structuredClone(meta.get(key)) as T) : undefined;
    },
    async setMeta<T>(key: string, value: T) {
      open();
      meta.set(key, structuredClone(value));
    },

    async usedBytes() {
      open();
      return used;
    },
    async estimate() {
      return quota === undefined ? undefined : { usageBytes: used, quotaBytes: quota };
    },
    async close() {
      closed = true;
    },
  };
}
