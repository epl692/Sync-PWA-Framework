// T069: the reference index follows object state (research R-09): never authoritative, always rebuildable.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { UNSET, newId } from '@sync/core';
import { extractRefs, validateRef } from '../../src';
import { refsIn } from '../../src/refs/watch';
import { pattern, testBlobs } from '../helpers';

const SPACE = 'SPACE1';
type T = Awaited<ReturnType<typeof testBlobs>>;

const poolRef = (t: T, i: number) => t.blobs.attach(new Blob([pattern(100 + i, i) as BlobPart]), { space: SPACE, obj: `pool-${i}` });
const refsOf = async (t: T, ref: { id: string }) => [...(await t.storage.getRefs(ref.id))].sort();
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('finding references', () => {
  it('at the top level, nested in an object and in a list, ignoring everything else', async () => {
    const t = await testBlobs();
    const [r1, r2, r3, r4] = await Promise.all([1, 2, 3, 4].map((i) => poolRef(t, i)));
    const fields = { a: r1, b: { deep: { c: r2 } }, l: [r3, 'x', 1, [r4]], note: 'text', n: 5, junk: { $blob: 1, id: 'bad' } };
    expect(refsIn(fields as never, 1 << 30).map((r) => r.id).sort()).toEqual([r1!.id, r2!.id, r3!.id, r4!.id].sort());
    expect(extractRefs(fields.junk)).toHaveLength(1); // found, then dropped by validation
    expect(validateRef(fields.junk).ok).toBe(false);
  });
});

describe('following object state', () => {
  it('records a reference on create, moves it on update, and drops it on delete; undo restores it', async () => {
    const t = await testBlobs();
    const [r1, r2] = await Promise.all([poolRef(t, 1), poolRef(t, 2)]);
    const o = await t.core.create(SPACE, 'note', { photo: r1 as never });
    await settle();
    expect(await refsOf(t, r1!)).toEqual([o.id]);
    expect((await t.storage.getBlob(r1!.id))!.unreferencedAt).toBeNull();

    t.clock.advance(1000);
    await t.core.update(o.id, { photo: r2 as never });
    await settle();
    expect(await refsOf(t, r1!)).toEqual([]);
    expect(await refsOf(t, r2!)).toEqual([o.id]);
    expect((await t.storage.getBlob(r1!.id))!.unreferencedAt).toBe(t.clock.now()); // the clock for r1 started now

    t.clock.advance(1000);
    await t.core.remove(o.id);
    await settle();
    expect(await refsOf(t, r2!)).toEqual([]);
    expect((await t.storage.getBlob(r2!.id))!.unreferencedAt).toBe(t.clock.now());

    t.clock.advance(1000);
    await t.core.undo(o.id);
    await settle();
    expect(await refsOf(t, r2!)).toEqual([o.id]);
    expect((await t.storage.getBlob(r2!.id))!.unreferencedAt).toBeNull();
  });

  it('an unset field drops its reference; two objects can hold one blob', async () => {
    const t = await testBlobs();
    const r = (await poolRef(t, 1))!;
    const a = await t.core.create(SPACE, 'note', { photo: r as never });
    const b = await t.core.create(SPACE, 'note', { photo: r as never, extra: 'x' });
    await settle();
    expect(await refsOf(t, r)).toEqual([a.id, b.id].sort());
    await t.core.update(a.id, { photo: UNSET });
    await settle();
    expect(await refsOf(t, r)).toEqual([b.id]);
    expect((await t.storage.getBlob(r.id))!.unreferencedAt).toBeNull(); // still referenced by b
  });

  it('reads the object after the packet, not the packet: an update that touches other fields keeps the reference', async () => {
    const t = await testBlobs();
    const r = (await poolRef(t, 1))!;
    const o = await t.core.create(SPACE, 'note', { photo: r as never, title: 'a' });
    await t.core.update(o.id, { title: 'b' });
    await settle();
    expect(await refsOf(t, r)).toEqual([o.id]);
  });
});

describe('rebuilding', () => {
  it('reindex() gives the same index as the one maintained incrementally (property over random operation sequences)', async () => {
    const t = await testBlobs();
    const pool = (await Promise.all([0, 1, 2, 3].map((i) => poolRef(t, i)))) as Awaited<ReturnType<typeof poolRef>>[];
    const ids: string[] = [];
    const snapshot = async () => Promise.all(pool.map(async (r) => refsOf(t, r)));
    const op = fc.oneof(
      fc.record({ k: fc.constant('create' as const), pick: fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 3 }) }),
      fc.record({ k: fc.constant('update' as const), who: fc.nat(), pick: fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 3 }) }),
      fc.record({ k: fc.constant('remove' as const), who: fc.nat() }),
      fc.record({ k: fc.constant('undo' as const), who: fc.nat() }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 12 }), async (ops) => {
        for (const o of ops) {
          t.clock.advance(10);
          const target = ids.length ? ids[o.k === 'create' ? 0 : (o as { who: number }).who % ids.length]! : undefined;
          const fieldsOf = (pick: number[]) => ({ list: pick.map((i) => pool[i]) as never, title: 'x' });
          try {
            if (o.k === 'create') ids.push((await t.core.create(SPACE, 'note', fieldsOf(o.pick), { id: newId() })).id);
            else if (!target) continue;
            else if (o.k === 'update') await t.core.update(target, fieldsOf(o.pick));
            else if (o.k === 'remove') await t.core.remove(target);
            else await t.core.undo(target);
          } catch {
            // an undo with nothing to undo, an update of a deleted object: not what is being tested
          }
        }
        await settle();
        const incremental = await snapshot();
        await t.blobs.reindex();
        expect(await snapshot()).toEqual(incremental);
      }),
      { numRuns: 25 },
    );
  }, 120_000);

  it('rebuilds on its own when the stored index version is not the current one', async () => {
    const t = await testBlobs();
    const r = (await poolRef(t, 1))!;
    const o = await t.core.create(SPACE, 'note', { photo: r as never });
    await settle();
    await t.storage.setRefs(r.id, []); // damage the stored mirror
    await t.storage.setMeta('refs:index', { version: 0, objects: {} });
    await t.blobs.reindex();
    expect(await refsOf(t, r)).toEqual([o.id]);
  });
});
