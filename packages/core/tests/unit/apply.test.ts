// T027: applyPacket semantics through the public ingest path.
import { describe, expect, it } from 'vitest';
import { UNSET } from '@sync/core';
import { createTestCore, remoteEnvelope } from '@sync/testkit';

const A = 'AAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'BBBBBBBBBBBBBBBBBBBBBBBBBB';

describe('applyPacket', () => {
  it('is idempotent: re-applying a packet changes nothing', async () => {
    const t = await createTestCore();
    const e = await remoteEnvelope({ obj: 'o1', op: 'create', type: 't', fields: { a: 1 } }, { author: A, seq: 1 });
    expect((await t.core.ingest(e.raw, 'p')).status).toBe('applied');
    const h1 = await t.core.stateHash('s1');
    expect((await t.core.ingest(e.raw, 'p')).status).toBe('duplicate');
    expect(await t.core.stateHash('s1')).toBe(h1);
  });

  it('resolves a field per-field by the greater clock, in any order', async () => {
    const lo = await remoteEnvelope({ obj: 'o1', op: 'update', type: 't', fields: { x: 'old', y: 1 } }, { author: A, seq: 1, wall: 1000 });
    const hi = await remoteEnvelope({ obj: 'o1', op: 'update', type: 't', fields: { x: 'new' } }, { author: B, seq: 1, wall: 2000 });
    for (const order of [[lo, hi], [hi, lo]]) {
      const t = await createTestCore();
      for (const e of order) await t.core.ingest(e!.raw, 'p');
      expect((await t.core.get('o1'))!.fields).toEqual({ x: 'new', y: 1 });
    }
  });

  it('breaks an exact wall/counter tie with the device id', async () => {
    const a = await remoteEnvelope({ obj: 'o1', op: 'update', type: 't', fields: { x: 'from-A' } }, { author: A, seq: 1, wall: 5000, counter: 0 });
    const b = await remoteEnvelope({ obj: 'o1', op: 'update', type: 't', fields: { x: 'from-B' } }, { author: B, seq: 1, wall: 5000, counter: 0 });
    for (const order of [[a, b], [b, a]]) {
      const t = await createTestCore();
      for (const e of order) await t.core.ingest(e!.raw, 'p');
      expect((await t.core.get('o1'))!.fields.x).toBe('from-B');
    }
  });

  it('materialises an object from an update that arrives before its create', async () => {
    const t = await createTestCore();
    const upd = await remoteEnvelope({ obj: 'o1', op: 'update', type: 't', fields: { b: 2 } }, { author: B, seq: 1, wall: 3000 });
    const cre = await remoteEnvelope({ obj: 'o1', op: 'create', type: 't', fields: { a: 1, b: 0 } }, { author: A, seq: 1, wall: 2000 });
    await t.core.ingest(upd.raw, 'p');
    expect(await t.core.get('o1')).toMatchObject({ type: 't', fields: { b: 2 } });
    await t.core.ingest(cre.raw, 'p');
    expect((await t.core.get('o1'))!.fields).toEqual({ a: 1, b: 2 });
  });

  it('removes a field with the unset marker, ordered by clock like any value', async () => {
    const t = await createTestCore();
    const set = await remoteEnvelope({ obj: 'o1', op: 'create', type: 't', fields: { a: 1, b: 2 } }, { author: A, seq: 1, wall: 1000 });
    const unset = await remoteEnvelope({ obj: 'o1', op: 'update', type: 't', fields: { a: { $unset: true } } }, { author: A, seq: 2, wall: 2000 });
    const lateSet = await remoteEnvelope({ obj: 'o1', op: 'update', type: 't', fields: { b: { $unset: true } } }, { author: B, seq: 1, wall: 500 });
    await t.core.ingest(unset.raw, 'p');
    await t.core.ingest(set.raw, 'p');
    await t.core.ingest(lateSet.raw, 'p');
    expect((await t.core.get('o1'))!.fields).toEqual({ b: 2 });
  });

  it('keeps a deleted object deleted (sticky tombstone) whatever the order', async () => {
    const del = await remoteEnvelope({ obj: 'o1', op: 'delete', type: 't', fields: {} }, { author: A, seq: 1, wall: 1000 });
    const edit = await remoteEnvelope({ obj: 'o1', op: 'update', type: 't', fields: { a: 1 } }, { author: B, seq: 1, wall: 9000 });
    for (const order of [[del, edit], [edit, del]]) {
      const t = await createTestCore();
      for (const e of order) await t.core.ingest(e!.raw, 'p');
      expect(await t.core.get('o1')).toBeUndefined();
    }
  });

  it('gives a local edit a clock above the stored field clock (causal bump)', async () => {
    const t = await createTestCore();
    const farFuture = t.clock.now() + 3_600_000; // an hour ahead, beyond the drift bound
    const skewed = await remoteEnvelope({ obj: 'o1', op: 'create', type: 't', fields: { x: 'skewed' } }, { author: A, seq: 1, wall: farFuture });
    await t.core.ingest(skewed.raw, 'p');
    await t.core.update('o1', { x: 'mine' });
    expect((await t.core.get('o1'))!.fields.x).toBe('mine');
    // and after a restart the edit still wins
    expect((await (await t.reopen()).get('o1'))!.fields.x).toBe('mine');
  });

  it('writes the unset marker for UNSET locally', async () => {
    const t = await createTestCore();
    const o = await t.core.create('s1', 'note', { a: 1, b: 2 });
    await t.core.update(o.id, { a: UNSET });
    expect((await t.core.get(o.id))!.fields).toEqual({ b: 2 });
  });

  it('assigns every local packet a distinct, increasing clock', async () => {
    const t = await createTestCore();
    const far = await remoteEnvelope({ obj: 'o1', op: 'create', type: 't', fields: { x: 1, y: 1 } }, { author: A, seq: 1, wall: t.clock.now() + 3_600_000 });
    await t.core.ingest(far.raw, 'p');
    await t.core.update('o1', { x: 2 }); // bumped above the far-future clock
    await t.core.update('o1', { y: 2 }); // normal tick would be lower than the previous packet clock
    await t.core.update('o1', { y: 3 });
    const { readPacketRecords } = await import('@sync/testkit');
    const clocks = (await readPacketRecords(t.storage)).filter((p) => p.author === t.core.deviceId).map((p) => p.clock);
    expect(new Set(clocks).size).toBe(clocks.length);
    expect([...clocks].sort()).toEqual(clocks.slice().sort());
    expect((await t.core.get('o1'))!.fields).toEqual({ x: 2, y: 3 });
  });
});
