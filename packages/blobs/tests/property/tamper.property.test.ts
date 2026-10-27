// T048 (SC-002): any single bit flipped anywhere in a manifest message or a chunk message in transit is rejected or
// ignored: the result is always the correct blob, and no stored chunk differs from the original. 100% of generated cases.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { flipBit, laneType } from '@sync/testkit';
import { pattern, plainPeers } from '../helpers';

const RUNS = Number(process.env.BLOB_TAMPER_RUNS ?? 1000);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

describe('tampered messages in transit (property)', () => {
  it(`never yields a wrong blob or stores a wrong chunk (${RUNS} cases)`, async () => {
    const t = await plainPeers(['a', 'b', 'c'], { requestTimeoutMs: 150 });
    let n = 0;
    let applied = 0;
    const size = fc.oneof(
      { weight: 9, arbitrary: fc.integer({ min: 1, max: 400_000 }) },
      { weight: 1, arbitrary: fc.integer({ min: 400_001, max: 3 * 1024 * 1024 }) },
    );
    await fc.assert(
      fc.asyncProperty(size, fc.integer(), fc.constantFrom('manifest' as const, 'chunk' as const), fc.integer({ min: 0, max: 6 }), fc.double({ min: 0, max: 0.999999, noNaN: true }), fc.integer({ min: 0, max: 7 }), async (sz, seed, kind, nth, frac, bit) => {
        const obj = `o${++n}`;
        const bytes = pattern(sz, seed & 0xffff);
        const ref = await t.attach('a', bytes, obj);
        await t.attach('c', bytes, obj); // the same blob on a second device (deterministic encryption)
        t.faults.clearRules();
        let seen = 0;
        const before = t.faults.stats.corrupted;
        t.faults.corruptNext(
          (m) => laneType(m) === kind && seen++ === nth,
          (m) => flipBit(m, 2 + Math.floor(frac * (m.length - 2)), bit),
          1,
        );
        await t.engines.b!.request(ref);
        applied += t.faults.stats.corrupted - before;

        // what b stored equals what a stored, chunk for chunk, and decrypts to the original bytes
        const want = await t.storages.a!.presentChunks(ref.id);
        expect(await t.storages.b!.presentChunks(ref.id)).toEqual(want);
        for (const i of want) expect(same((await t.storages.b!.getChunk(ref.id, i))!, (await t.storages.a!.getChunk(ref.id, i))!)).toBe(true);
        expect(same(new Uint8Array(await (await t.engines.b!.toBlob(ref)).arrayBuffer()), bytes)).toBe(true);

        for (const s of Object.values(t.storages)) await s.deleteBlob(ref.id);
      }),
      { numRuns: RUNS },
    );
    expect(applied).toBeGreaterThan(RUNS / 4); // the property really did corrupt messages, in most cases
    await t.close();
  }, 900_000);
});
