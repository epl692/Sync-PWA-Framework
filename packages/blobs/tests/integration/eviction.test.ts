// T073 (US4, FR-009): a storage budget with least-recently-used eviction that never loses the only copy.
import { describe, expect, it } from 'vitest';
import { storedBytes } from '../../src/policy/policy';
import { pattern, testBlobs } from '../helpers';

const SPACE = 'SPACE1';
const SIZE = 300_000;
const ONE = storedBytes(SIZE);

type T = Awaited<ReturnType<typeof testBlobs>>;
/** Attach a blob at the clock's current time. Nothing else holds a copy yet, so the budget cannot evict it while a test sets up. */
async function blob(t: T, seed: number) {
  t.clock.advance(1000);
  return t.blobs.attach(new Blob([pattern(SIZE, seed) as BlobPart]), { space: SPACE, obj: `o${seed}` });
}
/** Record that a relay holds a copy of each: from now on they may be evicted. */
async function confirm(t: T, ...refs: Array<{ id: string }>) {
  for (const ref of refs) await t.storage.putBlob({ ...(await t.storage.getBlob(ref.id))!, replicas: ['relay:1'] });
}
const has = async (t: T, ref: { id: string }) => (await t.storage.presentChunks(ref.id)).length > 0;

describe('budget and LRU', () => {
  it('evicts the least recently used first, stops at the budget, and keeps the record and manifest', async () => {
    const t = await testBlobs({ budgetBytes: ONE * 3 });
    const [a, b, c, d, e] = [await blob(t, 1), await blob(t, 2), await blob(t, 3), await blob(t, 4), await blob(t, 5)];
    await confirm(t, a, b, c, d, e);
    t.clock.advance(1000);
    await (await t.blobs.open(a)).cancel(); // touching `a` makes it recent: b and c are now the oldest
    const evicted: string[] = [];
    t.blobs.on('blob:evicted', (ev) => evicted.push(ev.id));
    const freed = await t.blobs.evict();
    expect(freed).toBe(ONE * 2);
    expect(evicted).toEqual([b.id, c.id]);
    expect(await has(t, a)).toBe(true);
    expect(await has(t, d)).toBe(true);
    expect(await has(t, e)).toBe(true);
    expect(await has(t, b)).toBe(false);
    const rec = (await t.storage.getBlob(b.id))!;
    expect(rec.complete).toBe(false);
    expect(rec.manifest.length).toBeGreaterThan(0);
    expect(t.blobs.observe(b).get()).toMatchObject({ state: 'missing', reason: 'evicted' });
    expect(await t.storage.usedBytes()).toBeLessThanOrEqual(ONE * 3);
  });

  it('evicts by itself after an attach pushes the device over the budget', async () => {
    const t = await testBlobs({ budgetBytes: ONE * 2 });
    const a = await blob(t, 1);
    const b = await blob(t, 2);
    await confirm(t, a, b); // both confirmed elsewhere: only the budget decides
    await blob(t, 3); // this attach pushes the device over its budget
    await new Promise((r) => setTimeout(r, 30));
    expect(await has(t, a)).toBe(false);
    expect(await t.storage.usedBytes()).toBeLessThanOrEqual(ONE * 2);
  });

  it('never evicts a pinned blob, a blob with no confirmed copy elsewhere, or one open in a stream', async () => {
    const t = await testBlobs({ budgetBytes: ONE });
    const pinned = await blob(t, 1);
    const lonely = await blob(t, 2);
    const open = await blob(t, 3);
    const spare = await blob(t, 4);
    await confirm(t, pinned, open, spare); // `lonely` stays the only known copy
    await t.blobs.pin(pinned);
    const stream = await t.blobs.open(open); // a lease: not read yet
    const events: Array<{ usedBytes: number; budgetBytes?: number }> = [];
    t.blobs.on('blob:storage', (e) => events.push(e));
    await t.blobs.evict();
    expect(await has(t, pinned)).toBe(true);
    expect(await has(t, lonely)).toBe(true);
    expect(await has(t, open)).toBe(true);
    expect(await has(t, spare)).toBe(false);
    // still over budget: the app is told
    expect(events.at(-1)!.usedBytes).toBeGreaterThan(ONE);
    expect(events.at(-1)!.budgetBytes).toBe(ONE);
    await stream.cancel(); // the lease ends
    await t.blobs.evict();
    expect(await has(t, open)).toBe(false);
  });

  it('never evicts anything with no budget configured (the Framework default), unless asked for a target', async () => {
    const t = await testBlobs();
    const a = await blob(t, 1);
    const b = await blob(t, 2);
    await confirm(t, a, b);
    expect(await t.blobs.evict()).toBe(0);
    expect(await has(t, a)).toBe(true);
    expect(await t.blobs.evict({ targetBytes: ONE })).toBe(ONE); // an explicit target frees what it can
    expect(await has(t, a)).toBe(false);
    expect(await t.blobs.evict({ targetBytes: 0 })).toBe(ONE);
  });

  it('a configured minReplicas of 2 protects a blob confirmed by one holder only', async () => {
    const t = await testBlobs({ minReplicas: 2 });
    const one = await blob(t, 1);
    const two = await blob(t, 2);
    await confirm(t, one);
    const rec = (await t.storage.getBlob(two.id))!;
    await t.storage.putBlob({ ...rec, replicas: ['relay:1', 'memory:b'] });
    expect(await t.blobs.evict({ targetBytes: 0 })).toBe(ONE);
    expect(await has(t, one)).toBe(true);
    expect(await has(t, two)).toBe(false);
  });
});
