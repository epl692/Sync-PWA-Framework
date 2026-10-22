// T010 (A-5, A-6): `$` types are hidden from untyped queries; pinned types survive compaction.
import { describe, expect, it } from 'vitest';
import { createTestCore, readPacketRecords } from '@sync/testkit';

const DAY = 24 * 60 * 60 * 1000;

describe('A-5 hidden $ types', () => {
  it('hides $sys.* from untyped queries but not from an exact-type query or get()', async () => {
    const t = await createTestCore();
    const sys = await t.core.create('s1', '$sys.x', { a: 1 });
    await t.core.create('s1', 'item', { a: 2 });
    expect((await t.core.query({}).once()).map((o) => o.type)).toEqual(['item']);
    expect((await t.core.query({ space: 's1' }).once()).map((o) => o.type)).toEqual(['item']);
    expect((await t.core.query({ type: '$sys.x' }).once()).map((o) => o.id)).toEqual([sys.id]);
    expect((await t.core.query({ id: sys.id }).once()).map((o) => o.id)).toEqual([sys.id]);
    expect(await t.core.get(sys.id)).toBeDefined();
  });
});

describe('A-6 compaction pin', () => {
  it('never folds or deletes pinned packets', async () => {
    const t = await createTestCore({ retentionWindowMs: 30 * DAY });
    t.core.registerCompactionPin((type) => type.startsWith('$sys.'));
    const sys = await t.core.create('s1', '$sys.x', { a: 1 });
    const item = await t.core.create('s1', 'item', { a: 2 });
    t.clock.advance(40 * DAY);
    const r = await t.core.compact();
    expect(r.packetsRemoved).toBe(1);
    const left = await readPacketRecords(t.storage);
    expect(left.map((p) => p.obj)).toEqual([sys.id]);
    expect((await t.core.get(sys.id))!.fields.a).toBe(1);
    expect((await t.core.get(item.id))!.fields.a).toBe(2);
    const snap = await t.core.exportSnapshot('s1');
    expect(snap!.objects.map((o) => o.id)).toEqual([item.id]);
  });
});
