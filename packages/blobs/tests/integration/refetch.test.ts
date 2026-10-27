// T075 (US4): an evicted blob comes back on demand without a second manifest round trip; pressure and quota hooks.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from '@sync/core';
import { createTestCore } from '@sync/testkit';
import { CHUNK_BYTES, createBlobs, createMemoryBlobStorage, decodeLaneMessage, type LaneMsg } from '../../src';
import { pattern, plainPeers, vectorProvider } from '../helpers';

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const gets = (t: Awaited<ReturnType<typeof plainPeers>>, from: string) =>
  t.faults.sent.filter((s) => s.from === from).flatMap((s) => {
    const d = decodeLaneMessage(s.bytes);
    return d.ok && 'msg' in d && d.msg.type === 'get' ? [d.msg as Extract<LaneMsg, { type: 'get' }>] : [];
  });

describe('re-fetching after eviction', () => {
  it('asks again without the manifest flag, because the record and manifest were kept', async () => {
    const t = await plainPeers(['a', 'b']);
    const bytes = pattern(CHUNK_BYTES * 3, 4);
    const ref = await t.attach('a', bytes);
    await t.engines.b!.request(ref);
    expect(gets(t, 'b')[0]!.manifest).toBe(true);
    await t.engines.b!.evict({ targetBytes: 0 });
    expect(t.engines.b!.observe(ref).get()).toMatchObject({ state: 'missing', reason: 'evicted' });
    const before = gets(t, 'b').length;
    await t.engines.b!.request(ref);
    const again = gets(t, 'b').slice(before);
    expect(again.length).toBeGreaterThan(0);
    expect(again.every((g) => !g.manifest)).toBe(true);
    expect(same(new Uint8Array(await (await t.engines.b!.toBlob(ref)).arrayBuffer()), bytes)).toBe(true);
    await t.close();
  }, 60_000);

  it('evicting and re-requesting any number of times never corrupts the blob (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: CHUNK_BYTES * 3 }), fc.integer({ min: 1, max: 3 }), fc.integer({ min: 1, max: 1000 }), async (size, cycles, seed) => {
        const t = await plainPeers(['a', 'b'], {}, seed);
        try {
          const bytes = pattern(size, seed);
          const ref = await t.attach('a', bytes);
          for (let i = 0; i < cycles; i++) {
            await t.engines.b!.request(ref);
            expect(same(new Uint8Array(await (await t.engines.b!.toBlob(ref)).arrayBuffer()), bytes)).toBe(true);
            expect(await t.engines.b!.evict({ targetBytes: 0 })).toBeGreaterThan(0);
            expect(await t.storages.b!.presentChunks(ref.id)).toEqual([]);
          }
        } finally {
          await t.close();
        }
      }),
      { numRuns: 30 },
    );
  }, 300_000);
});

describe('eviction triggers', () => {
  const pressured = () => {
    const base = createMemoryStorage();
    return Object.assign(base, { estimate: async () => ({ usageBytes: 95, quotaBytes: 100 }) }); // 95% full
  };

  async function engine(config: { budgetBytes?: number }) {
    const t = await createTestCore({ storage: pressured() });
    const storage = createMemoryBlobStorage();
    const blobs = await createBlobs({ core: t.core, keyProvider: await vectorProvider(), storage, config });
    const ref = await blobs.attach(new Blob([pattern(50_000) as BlobPart]), { space: 'SPACE1', obj: 'o1' });
    const rec = (await storage.getBlob(ref.id))!;
    await storage.putBlob({ ...rec, replicas: ['relay:1'] });
    return { t, blobs, storage, ref };
  }

  it('storage pressure on the packet store evicts down to the budget, only when a budget is set', async () => {
    const withBudget = await engine({ budgetBytes: 1000 });
    await withBudget.t.core.create('SPACE1', 'note', { x: 1 }); // a write makes the quota monitor look
    await new Promise((r) => setTimeout(r, 60));
    expect(await withBudget.storage.presentChunks(withBudget.ref.id)).toEqual([]);

    const noBudget = await engine({});
    await noBudget.t.core.create('SPACE1', 'note', { x: 1 });
    await new Promise((r) => setTimeout(r, 60));
    expect((await noBudget.storage.presentChunks(noBudget.ref.id)).length).toBeGreaterThan(0);
  });

  it('with evictOnQuota a download that runs out of room frees an evictable blob and completes; by default it fails', async () => {
    const stored = CHUNK_BYTES + 28;
    for (const evictOnQuota of [true, false]) {
      const t = await plainPeers(['a', 'b'], { evictOnQuota, window: 2 });
      const old = await t.attach('b', pattern(CHUNK_BYTES * 2, 7), 'old'); // already on b, and a relay has a copy
      const rec = (await t.storages.b!.getBlob(old.id))!;
      await t.storages.b!.putBlob({ ...rec, replicas: ['relay:1'] });
      t.storages.b!.setQuota(stored * 4);
      const ref = await t.attach('a', pattern(CHUNK_BYTES * 3, 8), 'new');
      const result = await t.engines.b!.request(ref).then(() => 'ok', (e) => (e as { reason: string }).reason);
      expect(result).toBe(evictOnQuota ? 'ok' : 'quota');
      expect((await t.storages.b!.presentChunks(old.id)).length).toBe(evictOnQuota ? 0 : 2);
      await t.close();
    }
  }, 120_000);
});
