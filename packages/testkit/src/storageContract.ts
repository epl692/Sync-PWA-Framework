import { afterEach, describe, expect, it } from 'vitest';
import { StorageQuotaError, type StorageAdapter } from '@sync/core';

export interface StorageContractOptions {
  /** Optional: an adapter that rejects any commit larger than ~1 KiB with a quota error. */
  makeQuotaLimited?: () => Promise<StorageAdapter> | StorageAdapter;
}

async function collect<T>(it: AsyncIterable<{ key: string; value: T }>) {
  const out: { key: string; value: T }[] = [];
  for await (const e of it) out.push(e);
  return out;
}

/**
 * Reusable StorageAdapter contract suite (Principle VIII). Call from a test file:
 *   storageContract('my adapter', () => new MyAdapter());
 */
export function storageContract(
  name: string,
  factory: () => Promise<StorageAdapter> | StorageAdapter,
  opts: StorageContractOptions = {},
) {
  describe(`StorageAdapter contract: ${name}`, () => {
    const open: StorageAdapter[] = [];
    const make = async () => {
      const a = await factory();
      open.push(a);
      return a;
    };
    afterEach(async () => {
      while (open.length) await open.pop()!.close();
    });

    it('stores and retrieves values per store, and deletes', async () => {
      const s = await make();
      await s.transaction(['objects', 'meta'], 'readwrite', async (tx) => {
        await tx.put('objects', 'a', { id: 'a', n: 1 });
        await tx.put('meta', 'a', { other: true });
      });
      await s.transaction(['objects', 'meta'], 'readonly', async (tx) => {
        expect(await tx.get('objects', 'a')).toEqual({ id: 'a', n: 1 });
        expect(await tx.get('meta', 'a')).toEqual({ other: true });
        expect(await tx.get('objects', 'missing')).toBeUndefined();
      });
      await s.transaction(['objects'], 'readwrite', (tx) => tx.delete('objects', 'a'));
      await s.transaction(['objects'], 'readonly', async (tx) => {
        expect(await tx.get('objects', 'a')).toBeUndefined();
      });
    });

    it('sees its own writes inside a transaction', async () => {
      const s = await make();
      await s.transaction(['objects'], 'readwrite', async (tx) => {
        await tx.put('objects', 'x', { v: 1 });
        expect(await tx.get('objects', 'x')).toEqual({ v: 1 });
        await tx.delete('objects', 'x');
        expect(await tx.get('objects', 'x')).toBeUndefined();
      });
    });

    it('rolls back every write when the transaction function throws', async () => {
      const s = await make();
      await s.transaction(['objects'], 'readwrite', (tx) => tx.put('objects', 'keep', { v: 0 }));
      await expect(
        s.transaction(['objects', 'packets'], 'readwrite', async (tx) => {
          await tx.put('objects', 'keep', { v: 99 });
          await tx.put('objects', 'new', { v: 1 });
          await tx.put('packets', 'p', { v: 1 });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      await s.transaction(['objects', 'packets'], 'readonly', async (tx) => {
        expect(await tx.get('objects', 'keep')).toEqual({ v: 0 });
        expect(await tx.get('objects', 'new')).toBeUndefined();
        expect(await tx.get('packets', 'p')).toBeUndefined();
      });
    });

    it('scans in primary key order with a limit', async () => {
      const s = await make();
      await s.transaction(['objects'], 'readwrite', async (tx) => {
        for (const k of ['c', 'a', 'b', 'd']) await tx.put('objects', k, { k });
      });
      await s.transaction(['objects'], 'readonly', async (tx) => {
        expect((await collect(tx.scan('objects'))).map((e) => e.key)).toEqual(['a', 'b', 'c', 'd']);
        expect((await collect(tx.scan('objects', { limit: 2 }))).map((e) => e.key)).toEqual(['a', 'b']);
        expect((await collect(tx.scan('objects', { range: { gte: 'b', lt: 'd' } }))).map((e) => e.key)).toEqual(['b', 'c']);
      });
    });

    it('scans by the bySpace, byClock and byAuthor indexes', async () => {
      const s = await make();
      await s.transaction(['packets'], 'readwrite', async (tx) => {
        await tx.put('packets', 'p1', { space: 's1', clock: '0003', author: 'A' });
        await tx.put('packets', 'p2', { space: 's2', clock: '0001', author: 'B' });
        await tx.put('packets', 'p3', { space: 's1', clock: '0002', author: 'B' });
        await tx.put('packets', 'p4', { space: 's1', clock: '0001', author: 'A' });
      });
      await s.transaction(['packets'], 'readonly', async (tx) => {
        const keys = async (o: Parameters<typeof tx.scan>[1]) => (await collect(tx.scan('packets', o))).map((e) => e.key);
        expect(await keys({ index: 'bySpace', range: { gte: 's1', lt: 's1\u0000' } })).toHaveLength(3);
        expect(await keys({ index: 'byClock' })).toEqual(['p2', 'p4', 'p3', 'p1']);
        expect(await keys({ index: 'byClock', range: { gte: '0002', lt: '0003' } })).toEqual(['p3']);
        expect(await keys({ index: 'byAuthor', range: { gte: 'B', lt: 'B\u0000' } })).toEqual(['p2', 'p3']);
      });
    });

    it('returns copies, so callers cannot mutate stored state', async () => {
      const s = await make();
      await s.transaction(['objects'], 'readwrite', (tx) => tx.put('objects', 'o', { list: [1, 2], bytes: new Uint8Array([1, 2]) }));
      await s.transaction(['objects'], 'readwrite', async (tx) => {
        const v: any = await tx.get('objects', 'o');
        v.list.push(3);
        v.bytes[0] = 99;
      });
      await s.transaction(['objects'], 'readonly', async (tx) => {
        const v: any = await tx.get('objects', 'o');
        expect(v.list).toEqual([1, 2]);
        expect(Array.from(v.bytes)).toEqual([1, 2]);
      });
    });

    it('serialises concurrent read-modify-write transactions', async () => {
      const s = await make();
      await s.transaction(['meta'], 'readwrite', (tx) => tx.put('meta', 'n', { n: 0 }));
      await Promise.all(
        Array.from({ length: 20 }, () =>
          s.transaction(['meta'], 'readwrite', async (tx) => {
            const cur: any = await tx.get('meta', 'n');
            await tx.put('meta', 'n', { n: cur.n + 1 });
          }),
        ),
      );
      await s.transaction(['meta'], 'readonly', async (tx) => {
        expect(await tx.get('meta', 'n')).toEqual({ n: 20 });
      });
    });

    if (opts.makeQuotaLimited) {
      it('surfaces quota problems as StorageQuotaError and leaves state unchanged', async () => {
        const s = await opts.makeQuotaLimited!();
        open.push(s);
        await s.transaction(['objects'], 'readwrite', (tx) => tx.put('objects', 'small', { v: 1 }));
        await expect(
          s.transaction(['objects'], 'readwrite', async (tx) => {
            await tx.put('objects', 'small', { v: 2 });
            await tx.put('objects', 'huge', { blob: 'x'.repeat(100_000) });
          }),
        ).rejects.toBeInstanceOf(StorageQuotaError);
        await s.transaction(['objects'], 'readonly', async (tx) => {
          expect(await tx.get('objects', 'small')).toEqual({ v: 1 });
          expect(await tx.get('objects', 'huge')).toBeUndefined();
        });
      });
    }
  });
}
