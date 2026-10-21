// T026 (Story 1): everything works with no transport, survives restart, and fills the outbox.
import { describe, expect, it } from 'vitest';
import { createTestCore, flush, readOutbox, readPacketRecords } from '@sync/testkit';

describe('Story 1: work fully offline', () => {
  it('creates an object that is visible immediately and survives a restart (scenario 1)', async () => {
    const t = await createTestCore();
    const o = await t.core.create('s1', 'note', { title: 'hello', n: 1 });
    expect(await t.core.get(o.id)).toMatchObject({ type: 'note', space: 's1', fields: { title: 'hello', n: 1 } });
    expect(await t.core.query({ type: 'note' }).once()).toHaveLength(1);

    const again = await t.reopen();
    expect(await again.get(o.id)).toMatchObject({ fields: { title: 'hello', n: 1 } });
    expect(await again.query({ type: 'note' }).once()).toHaveLength(1);
    expect(again.deviceId).toBe(t.core.deviceId);
  });

  it('applies an offline edit immediately and records an outbox packet (scenario 2)', async () => {
    const t = await createTestCore();
    const o = await t.core.create('s1', 'note', { title: 'a' });
    const seen: unknown[] = [];
    t.core.query({ id: o.id }).subscribe((r) => seen.push(r[0]?.fields.title));
    await t.core.update(o.id, { title: 'b' });
    await flush();
    expect(seen).toEqual(['a', 'b']);
    expect((await t.core.get(o.id))!.fields.title).toBe('b');

    const outbox = await readOutbox(t.storage);
    expect(outbox).toHaveLength(2);
    const packets = await readPacketRecords(t.storage);
    expect(packets.map((p) => p.op).sort()).toEqual(['create', 'update']);
  });

  it('removes a deleted object from every query and records a delete packet (scenario 3)', async () => {
    const t = await createTestCore();
    const o = await t.core.create('s1', 'note', { title: 'a' });
    await t.core.remove(o.id);
    expect(await t.core.get(o.id)).toBeUndefined();
    expect(await t.core.query({ type: 'note' }).once()).toEqual([]);
    expect(await t.core.query({ id: o.id }).once()).toEqual([]);
    const packets = await readPacketRecords(t.storage);
    expect(packets.map((p) => p.op).sort()).toEqual(['create', 'delete']);
    expect(await readOutbox(t.storage)).toHaveLength(2);

    const again = await t.reopen();
    expect(await again.get(o.id)).toBeUndefined();
  });

  it('keeps working with all CRUD and no transports attached', async () => {
    const t = await createTestCore();
    expect(t.core.transports()).toEqual([]);
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) ids.push((await t.core.create('s1', 'item', { i })).id);
    for (const id of ids.slice(0, 10)) await t.core.update(id, { done: true });
    for (const id of ids.slice(20)) await t.core.remove(id);
    const live = await t.core.query({ type: 'item' }).once();
    expect(live).toHaveLength(20);
    expect(live.filter((o) => o.fields.done === true)).toHaveLength(10);
  });

  it('rejects updates to objects that do not exist', async () => {
    const t = await createTestCore();
    await expect(t.core.update('nope', { a: 1 })).rejects.toMatchObject({ code: 'not-found' });
  });
});
