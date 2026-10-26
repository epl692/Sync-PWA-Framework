// T008 (C-1, spec 003): types can be registered with the core after it is open.
import { describe, expect, it } from 'vitest';
import { createTestCore, remoteEnvelope } from '@sync/testkit';

const create = (wall: number) => remoteEnvelope({ obj: 'o1', op: 'create', type: 'm.doc', fields: { v: 'start' } }, { author: 'CREATORDEVICE', seq: 1, wall });
const del = (wall: number) => remoteEnvelope({ obj: 'o1', op: 'delete', type: 'm.doc', fields: {} }, { author: 'DELETERDEVICE', seq: 1, wall });
const edit = (wall: number, v: string) => remoteEnvelope({ obj: 'o1', op: 'update', type: 'm.doc', fields: { v } }, { author: 'EDITORDEVICE', seq: 1, wall });

describe('C-1 registerType', () => {
  it('makes a deleted-then-edited object visible once the type resurrects, and hides it again on unregister', async () => {
    const t = await createTestCore();
    for (const e of [await create(100), await del(200), await edit(300, 'revived')]) await t.core.ingest(e.raw, 'p');
    expect(await t.core.get('o1')).toBeUndefined();
    t.core.registerType('m.doc', { resurrects: true });
    expect((await t.core.get('o1'))!.fields.v).toBe('revived');
    t.core.unregisterType('m.doc');
    expect(await t.core.get('o1')).toBeUndefined();
  });

  it('stops undo of a delete being NotUndoable once the type resurrects', async () => {
    const t = await createTestCore();
    const doc = await t.core.create('s1', 'm.doc', { v: 1 });
    t.clock.advance(10);
    await t.core.remove(doc.id);
    t.clock.advance(10);
    await expect(t.core.undo(doc.id)).rejects.toMatchObject({ code: 'not-undoable' });
    t.core.registerType('m.doc', { resurrects: true });
    await t.core.undo(doc.id);
    expect((await t.core.get(doc.id))!.fields).toEqual({ v: 1 });
  });

  it('re-emits live queries when visibility changes', async () => {
    const t = await createTestCore();
    for (const e of [await create(100), await del(200), await edit(300, 'revived')]) await t.core.ingest(e.raw, 'p');
    const seen: number[] = [];
    const unsub = t.core.query({ type: 'm.doc' }).subscribe((r) => seen.push(r.length));
    expect(seen).toEqual([0]);
    t.core.registerType('m.doc', { resurrects: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([0, 1]);
    t.core.unregisterType('m.doc');
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([0, 1, 0]);
    unsub();
  });

  it('is idempotent, and resurrects:false is the same as not registering', async () => {
    const t = await createTestCore();
    t.core.registerType('m.doc', { resurrects: true });
    t.core.registerType('m.doc', { resurrects: true });
    t.core.registerType('m.doc', { resurrects: false });
    for (const e of [await create(100), await del(200), await edit(300, 'x')]) await t.core.ingest(e.raw, 'p');
    expect(await t.core.get('o1')).toBeUndefined();
  });

  it('refuses $-prefixed types', async () => {
    const t = await createTestCore();
    expect(() => t.core.registerType('$sys.x', { resurrects: true })).toThrow();
  });

  it('keeps types seeded from Config.resurrectingTypes', async () => {
    const t = await createTestCore({ resurrectingTypes: ['m.doc'] });
    for (const e of [await create(100), await del(200), await edit(300, 'revived')]) await t.core.ingest(e.raw, 'p');
    expect((await t.core.get('o1'))!.fields.v).toBe('revived');
  });
});
