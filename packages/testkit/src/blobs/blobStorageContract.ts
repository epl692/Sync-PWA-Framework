/**
 * Reusable BlobStorage contract suite (spec 004, Principle VIII). Every implementation (memory, IndexedDB, the relay's
 * file store) must pass it:
 *   blobStorageContract('my store', { create })
 */
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { StorageQuotaError } from '@sync/core';
import type { BlobStorage, StoredBlob } from '@sync/blobs';

export interface BlobStorageHarness {
  /** A fresh, empty store. `reopen` closes it and opens the same data again (persistent stores only). */
  create(): Promise<{
    storage: BlobStorage;
    reopen?(): Promise<BlobStorage>;
    /** Make later chunk writes beyond `bytes` of stored data fail with StorageQuotaError. Omit when the store cannot simulate it. */
    setQuota?(bytes: number | undefined): void;
    teardown?(): Promise<void>;
  }>;
}

const rec = (id: string, over: Partial<StoredBlob> = {}): StoredBlob => ({
  id,
  manifest: Uint8Array.from([1, 2, 3]),
  space: 'SPACE',
  scope: 'SPACE',
  keyId: '0123456789abcdef',
  size: 10,
  type: 'text/plain',
  origin: 'local',
  replicas: [],
  pinned: false,
  createdAt: 1,
  lastAccessAt: 1,
  unreferencedAt: null,
  ...over,
});
const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * seed + 3) & 0xff);
const same = (a: Uint8Array | undefined, b: Uint8Array) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);

export function blobStorageContract(name: string, harness: BlobStorageHarness) {
  describe(`BlobStorage contract: ${name}`, () => {
    const cleanups: (() => Promise<void>)[] = [];
    afterEach(async () => {
      while (cleanups.length) await cleanups.pop()!().catch(() => undefined);
    });
    async function open() {
      const h = await harness.create();
      cleanups.push(async () => {
        await h.storage.close().catch(() => undefined);
        await h.teardown?.();
      });
      return h;
    }

    it('stores, replaces and reads back a record without touching chunks', async () => {
      const { storage: s } = await open();
      expect(await s.getBlob('a')).toBeUndefined();
      await s.putChunk('a', 0, bytes(10));
      await s.putBlob(rec('a'));
      expect(await s.getBlob('a')).toEqual(rec('a'));
      await s.putBlob(rec('a', { pinned: true, replicas: ['relay:1'], lastAccessAt: 9 }));
      expect(await s.getBlob('a')).toMatchObject({ pinned: true, replicas: ['relay:1'], lastAccessAt: 9 });
      expect(await s.presentChunks('a')).toEqual([0]);
    });

    it('does not alias what callers pass in or get back', async () => {
      const { storage: s } = await open();
      const m = Uint8Array.from([5, 5, 5]);
      await s.putBlob(rec('a', { manifest: m }));
      m[0] = 9;
      const got = (await s.getBlob('a'))!;
      expect(got.manifest[0]).toBe(5);
      const c = bytes(8);
      await s.putChunk('a', 0, c);
      c[0] = 77;
      expect(same(await s.getChunk('a', 0), bytes(8))).toBe(true);
    });

    it('puts chunks idempotently and lists the present ones ascending', async () => {
      const { storage: s } = await open();
      for (const i of [5, 1, 3]) await s.putChunk('a', i, bytes(20, i));
      await s.putChunk('a', 3, bytes(20, 3)); // again
      expect(await s.presentChunks('a')).toEqual([1, 3, 5]);
      expect(same(await s.getChunk('a', 3), bytes(20, 3))).toBe(true);
      expect(await s.getChunk('a', 2)).toBeUndefined();
      expect(await s.getChunk('zzz', 0)).toBeUndefined();
      expect(await s.usedBytes()).toBe(60);
    });

    it('keeps chunks of different blobs apart (including ids that share a prefix)', async () => {
      const { storage: s } = await open();
      await s.putChunk('ab', 0, bytes(5));
      await s.putChunk('abc', 0, bytes(7));
      expect(await s.presentChunks('ab')).toEqual([0]);
      expect((await s.getChunk('abc', 0))!.length).toBe(7);
      await s.deleteChunks('ab');
      expect((await s.getChunk('abc', 0))!.length).toBe(7);
    });

    it('deleteChunks returns the bytes freed and keeps the record', async () => {
      const { storage: s } = await open();
      await s.putBlob(rec('a'));
      await s.putChunk('a', 0, bytes(100));
      await s.putChunk('a', 1, bytes(50));
      expect(await s.deleteChunks('a')).toBe(150);
      expect(await s.presentChunks('a')).toEqual([]);
      expect(await s.getBlob('a')).toBeDefined();
      expect(await s.usedBytes()).toBe(0);
      expect(await s.deleteChunks('a')).toBe(0);
    });

    it('deleteBlob removes the record, chunks and refs', async () => {
      const { storage: s } = await open();
      await s.putBlob(rec('a'));
      await s.putChunk('a', 0, bytes(10));
      await s.setRefs('a', ['o1', 'o2']);
      await s.deleteBlob('a');
      expect(await s.getBlob('a')).toBeUndefined();
      expect(await s.presentChunks('a')).toEqual([]);
      expect(await s.getRefs('a')).toEqual([]);
      expect(await s.usedBytes()).toBe(0);
    });

    it('moveChunks renames a partial to its final ID and drops duplicates already present there', async () => {
      const { storage: s } = await open();
      await s.putChunk('tmp', 0, bytes(10, 2));
      await s.putChunk('tmp', 1, bytes(10, 3));
      await s.putChunk('final', 1, bytes(10, 3)); // already there
      await s.moveChunks('tmp', 'final');
      expect(await s.presentChunks('tmp')).toEqual([]);
      expect(await s.presentChunks('final')).toEqual([0, 1]);
      expect(same(await s.getChunk('final', 0), bytes(10, 2))).toBe(true);
      expect(await s.usedBytes()).toBe(20);
      await s.moveChunks('missing', 'final'); // nothing to move: no error
    });

    it('stores references and meta values by key', async () => {
      const { storage: s } = await open();
      expect(await s.getRefs('a')).toEqual([]);
      await s.setRefs('a', ['x', 'y']);
      expect(await s.getRefs('a')).toEqual(['x', 'y']);
      await s.setRefs('a', []);
      expect(await s.getRefs('a')).toEqual([]);
      expect(await s.getMeta('k')).toBeUndefined();
      await s.setMeta('k', { n: 1, list: ['a'] });
      expect(await s.getMeta('k')).toEqual({ n: 1, list: ['a'] });
    });

    it('lists records oldest-first by lastAccessAt or createdAt, with a limit', async () => {
      const { storage: s } = await open();
      await s.putBlob(rec('c', { lastAccessAt: 30, createdAt: 1 }));
      await s.putBlob(rec('a', { lastAccessAt: 10, createdAt: 3 }));
      await s.putBlob(rec('b', { lastAccessAt: 20, createdAt: 2 }));
      const ids = async (o?: Parameters<BlobStorage['listBlobs']>[0]) => {
        const out: string[] = [];
        for await (const b of s.listBlobs(o)) out.push(b.id);
        return out;
      };
      expect(await ids()).toEqual(['a', 'b', 'c']);
      expect(await ids({ orderBy: 'createdAt' })).toEqual(['c', 'b', 'a']);
      expect(await ids({ limit: 2 })).toEqual(['a', 'b']);
    });

    it('keeps usedBytes equal to the sum of stored chunks after any sequence of operations (property)', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.oneof(
              fc.record({ op: fc.constant('put' as const), id: fc.constantFrom('a', 'b', 'c'), i: fc.integer({ min: 0, max: 4 }), n: fc.integer({ min: 1, max: 40 }) }),
              fc.record({ op: fc.constant('dropChunks' as const), id: fc.constantFrom('a', 'b', 'c') }),
              fc.record({ op: fc.constant('deleteBlob' as const), id: fc.constantFrom('a', 'b', 'c') }),
              fc.record({ op: fc.constant('move' as const), id: fc.constantFrom('a', 'b', 'c'), to: fc.constantFrom('a', 'b', 'c') }),
            ),
            { maxLength: 25 },
          ),
          async (ops) => {
            const { storage: s, teardown } = await harness.create();
            try {
              for (const o of ops) {
                if (o.op === 'put') await s.putChunk(o.id, o.i, bytes(o.n, o.i + 1));
                else if (o.op === 'dropChunks') await s.deleteChunks(o.id);
                else if (o.op === 'deleteBlob') await s.deleteBlob(o.id);
                else await s.moveChunks(o.id, o.to);
              }
              let sum = 0;
              for (const id of ['a', 'b', 'c']) for (const i of await s.presentChunks(id)) sum += (await s.getChunk(id, i))!.length;
              expect(await s.usedBytes()).toBe(sum);
            } finally {
              await s.close().catch(() => undefined);
              await teardown?.();
            }
          },
        ),
        { numRuns: 25 },
      );
    });

    it('survives close and reopen when the store is persistent', async () => {
      const h = await open();
      if (!h.reopen) return;
      await h.storage.putBlob(rec('a'));
      await h.storage.putChunk('a', 0, bytes(33));
      await h.storage.setRefs('a', ['o']);
      await h.storage.setMeta('m', 7);
      const again = await h.reopen();
      cleanups.push(() => again.close());
      expect(await again.getBlob('a')).toEqual(rec('a'));
      expect(same(await again.getChunk('a', 0), bytes(33))).toBe(true);
      expect(await again.getRefs('a')).toEqual(['o']);
      expect(await again.getMeta('m')).toBe(7);
      expect(await again.usedBytes()).toBe(33);
    });

    it('rejects a chunk write over quota with StorageQuotaError and leaves state unchanged', async () => {
      const h = await open();
      if (!h.setQuota) return;
      await h.storage.putChunk('a', 0, bytes(100));
      h.setQuota(150);
      await expect(h.storage.putChunk('a', 1, bytes(100))).rejects.toBeInstanceOf(StorageQuotaError);
      expect(await h.storage.presentChunks('a')).toEqual([0]);
      expect(await h.storage.usedBytes()).toBe(100);
      h.setQuota(undefined);
      await h.storage.putChunk('a', 1, bytes(100));
      expect(await h.storage.presentChunks('a')).toEqual([0, 1]);
    });
  });
}
