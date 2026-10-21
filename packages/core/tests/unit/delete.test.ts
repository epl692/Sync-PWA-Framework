// T061 (FR-011, FR-012): tombstones, and "edit resurrects" for types that opt in.
import { describe, expect, it } from 'vitest';
import { createTestCore, remoteEnvelope } from '@sync/testkit';

const del = (wall: number, seq = 1, author = 'DELETERDEVICE') =>
  remoteEnvelope({ obj: 'o1', op: 'delete', type: 'doc', fields: {} }, { author, seq, wall });
const edit = (wall: number, v: string, seq = 1, author = 'EDITORDEVICE') =>
  remoteEnvelope({ obj: 'o1', op: 'update', type: 'doc', fields: { v } }, { author, seq, wall });
const create = (wall: number) => remoteEnvelope({ obj: 'o1', op: 'create', type: 'doc', fields: { v: 'start' } }, { author: 'CREATORDEVICE', seq: 1, wall });

describe('delete vs concurrent edit', () => {
  it('keeps the object deleted whichever packet arrives first, even if the edit has the later clock', async () => {
    const packets = [await create(100), await del(200), await edit(300, 'late edit')];
    for (const order of [[0, 1, 2], [0, 2, 1], [2, 1, 0], [1, 2, 0], [2, 0, 1], [1, 0, 2]]) {
      const t = await createTestCore();
      for (const i of order) await t.core.ingest(packets[i]!.raw, 'p');
      expect(await t.core.get('o1'), `order ${order}`).toBeUndefined();
      expect(await t.core.query({ type: 'doc' }).once()).toEqual([]);
    }
  });

  it('keeps the tombstone state in the state hash, so peers agree the object is deleted', async () => {
    const a = await createTestCore();
    const b = await createTestCore();
    const ps = [await create(100), await del(200)];
    for (const e of ps) await a.core.ingest(e.raw, 'p');
    for (const e of [...ps].reverse()) await b.core.ingest(e.raw, 'p');
    expect(await a.core.stateHash('s1')).toBe(await b.core.stateHash('s1'));
  });

  it('on a local delete then an incoming concurrent edit, the object stays deleted', async () => {
    const t = await createTestCore();
    const o = await t.core.create('s1', 'doc', { v: 'a' });
    await t.core.remove(o.id);
    const concurrent = await remoteEnvelope({ obj: o.id, op: 'update', type: 'doc', fields: { v: 'x' } }, { author: 'EDITORDEVICE', seq: 1, wall: t.clock.now() + 10_000 });
    await t.core.ingest(concurrent.raw, 'p');
    expect(await t.core.get(o.id)).toBeUndefined();
  });

  it('cannot update an object after deleting it', async () => {
    const t = await createTestCore();
    const o = await t.core.create('s1', 'doc', { v: 'a' });
    await t.core.remove(o.id);
    await expect(t.core.update(o.id, { v: 'b' })).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('types that opt into "edit resurrects"', () => {
  const cfg = { resurrectingTypes: ['doc'] };

  it('shows the object again when an edit is newer than the delete', async () => {
    const t = await createTestCore(cfg);
    for (const e of [await create(100), await del(200), await edit(300, 'revived')]) await t.core.ingest(e.raw, 'p');
    expect((await t.core.get('o1'))!.fields.v).toBe('revived');
  });

  it('keeps it deleted when the edit is older than the delete', async () => {
    const t = await createTestCore(cfg);
    for (const e of [await create(100), await edit(150, 'old edit'), await del(200)]) await t.core.ingest(e.raw, 'p');
    expect(await t.core.get('o1')).toBeUndefined();
  });

  it('is order independent', async () => {
    const packets = [await create(100), await del(200), await edit(300, 'revived')];
    const hashes = new Set<string>();
    const visible = new Set<boolean>();
    for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0], [2, 0, 1]]) {
      const t = await createTestCore(cfg);
      for (const i of order) await t.core.ingest(packets[i]!.raw, 'p');
      hashes.add(await t.core.stateHash('s1'));
      visible.add(!!(await t.core.get('o1')));
    }
    expect(hashes.size).toBe(1);
    expect([...visible]).toEqual([true]);
  });

  it('does not apply to other types', async () => {
    const t = await createTestCore({ resurrectingTypes: ['somethingelse'] });
    for (const e of [await create(100), await del(200), await edit(300, 'nope')]) await t.core.ingest(e.raw, 'p');
    expect(await t.core.get('o1')).toBeUndefined();
  });
});
