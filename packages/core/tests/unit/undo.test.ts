// T082 (FR-018): undo is a new compensating packet, never an edit of history.
import { describe, expect, it } from 'vitest';
import { NotUndoableError } from '@sync/core';
import { createPeers, createTestCore, readPacketRecords, remoteEnvelope, waitFor } from '@sync/testkit';

const DAY = 24 * 60 * 60 * 1000;

describe('undo', () => {
  it('restores the previous field values with a new compensating packet (Story 5 scenario 1)', async () => {
    const t = await createTestCore();
    const o = await t.core.create('s1', 'note', { title: 'one', body: 'text' });
    t.clock.advance(1000);
    await t.core.update(o.id, { title: 'two', body: 'changed' });
    const before = (await readPacketRecords(t.storage)).length;
    t.clock.advance(1000);
    await t.core.undo(o.id);
    expect((await t.core.get(o.id))!.fields).toEqual({ title: 'one', body: 'text' });
    const after = await readPacketRecords(t.storage);
    expect(after.length).toBe(before + 1); // history is append-only
    expect(after.filter((p) => p.op === 'update')).toHaveLength(2);
  });

  it('removes a field that did not exist before the edit', async () => {
    const t = await createTestCore();
    const o = await t.core.create('s1', 'note', { a: 1 });
    t.clock.advance(10);
    await t.core.update(o.id, { b: 2 });
    t.clock.advance(10);
    await t.core.undo(o.id);
    expect((await t.core.get(o.id))!.fields).toEqual({ a: 1 });
  });

  it('undoing a create deletes the object', async () => {
    const t = await createTestCore();
    const o = await t.core.create('s1', 'note', { a: 1 });
    t.clock.advance(10);
    await t.core.undo(o.id);
    expect(await t.core.get(o.id)).toBeUndefined();
  });

  it('can be undone again (redo), step by step', async () => {
    const t = await createTestCore();
    const o = await t.core.create('s1', 'note', { v: 1 });
    t.clock.advance(10);
    await t.core.update(o.id, { v: 2 });
    t.clock.advance(10);
    await t.core.undo(o.id);
    expect((await t.core.get(o.id))!.fields.v).toBe(1);
    t.clock.advance(10);
    await t.core.undo(o.id); // undoes the undo
    expect((await t.core.get(o.id))!.fields.v).toBe(2);
  });

  it('only reverses this device\'s own change, using the value that was in place before it', async () => {
    const t = await createTestCore();
    const base = await remoteEnvelope({ obj: 'o1', op: 'create', type: 'note', fields: { v: 'remote' } }, { author: 'REMOTEDEVICE', seq: 1, wall: t.clock.now() - 5000 });
    await t.core.ingest(base.raw, 'p');
    t.clock.advance(100);
    await t.core.update('o1', { v: 'mine' });
    t.clock.advance(100);
    await t.core.undo('o1');
    expect((await t.core.get('o1'))!.fields.v).toBe('remote');
  });

  it('reports NotUndoable when this device has no change to reverse', async () => {
    const t = await createTestCore();
    const base = await remoteEnvelope({ obj: 'o1', op: 'create', type: 'note', fields: { v: 1 } }, { seq: 1 });
    await t.core.ingest(base.raw, 'p');
    await expect(t.core.undo('o1')).rejects.toBeInstanceOf(NotUndoableError);
    await expect(t.core.undo('missing')).rejects.toBeInstanceOf(NotUndoableError);
  });

  it('reports NotUndoable outside the retention window', async () => {
    const t = await createTestCore({ retentionWindowMs: 7 * DAY });
    const o = await t.core.create('s1', 'note', { v: 1 });
    t.clock.advance(8 * DAY);
    await expect(t.core.undo(o.id)).rejects.toMatchObject({ code: 'not-undoable' });
  });

  it('undoing a delete works for types that opt into "edit resurrects", and is NotUndoable otherwise', async () => {
    const t = await createTestCore({ resurrectingTypes: ['doc'] });
    const doc = await t.core.create('s1', 'doc', { v: 1 });
    const plain = await t.core.create('s1', 'note', { v: 1 });
    t.clock.advance(10);
    await t.core.remove(doc.id);
    await t.core.remove(plain.id);
    t.clock.advance(10);
    await t.core.undo(doc.id);
    expect((await t.core.get(doc.id))!.fields).toEqual({ v: 1 });
    await expect(t.core.undo(plain.id)).rejects.toBeInstanceOf(NotUndoableError);
    expect(await t.core.get(plain.id)).toBeUndefined();
  });

  it('propagates like any other packet', async () => {
    const p = await createPeers(['a', 'b'], { spaces: ['s1'] });
    p.link('a', 'b');
    const o = await p.core('a').create('s1', 'note', { v: 1 });
    p.peers.a!.clock.advance(10);
    await p.core('a').update(o.id, { v: 2 });
    await p.converged('s1');
    p.peers.a!.clock.advance(10);
    await p.core('a').undo(o.id);
    await waitFor(async () => (await p.core('b').get(o.id))?.fields.v === 1, 3000, 'undo to reach b');
  });

  it('history lists the packets that touched an object, oldest first', async () => {
    const t = await createTestCore();
    const o = await t.core.create('s1', 'note', { a: 1 });
    t.clock.advance(10);
    await t.core.update(o.id, { a: 2, b: 3 });
    t.clock.advance(10);
    await t.core.remove(o.id);
    const h = await t.core.history(o.id);
    expect(h.map((x) => x.op)).toEqual(['create', 'update', 'delete']);
    expect(h[1]!.fields.sort()).toEqual(['a', 'b']);
    expect([...h].sort((x, y) => (x.clock < y.clock ? -1 : 1))).toEqual(h);
  });
});
