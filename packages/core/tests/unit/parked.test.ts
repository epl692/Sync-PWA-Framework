// T062 (FR-009): packets we cannot apply yet are stored, counted as held, relayed, and applied later.
import { describe, expect, it } from 'vitest';
import { canonicalBytes, type PacketValidator, type PayloadCodec } from '@sync/core';
import { createPeers, createTestCore, readPacketRecords, remoteEnvelope, waitFor } from '@sync/testkit';

const lateCodec: PayloadCodec = {
  id: 'late-cipher/1',
  encode: async (body) => canonicalBytes(body),
  decode: async (bytes) => ({ ok: true, body: JSON.parse(new TextDecoder().decode(bytes)) }),
};

describe('parked packets', () => {
  it('parks a packet with an unknown codec: stored, held, not applied', async () => {
    const t = await createTestCore();
    const e = await remoteEnvelope({ obj: 'o1', op: 'create', type: 't', fields: { a: 1 } }, { author: 'OTHERDEVICE', seq: 1, codecId: 'late-cipher/1' });
    expect(await t.core.ingest(e.raw, 'p')).toMatchObject({ status: 'parked', reason: 'undecodable-codec' });
    expect(await t.core.get('o1')).toBeUndefined();
    const rec = (await readPacketRecords(t.storage))[0]!;
    expect(rec).toMatchObject({ id: e.env.id, status: 'parked', reason: 'undecodable-codec' });
    expect(await t.core.ingest(e.raw, 'p')).toMatchObject({ status: 'duplicate' }); // counted as held
  });

  it('parks a packet with a newer envelope version', async () => {
    const t = await createTestCore();
    const raw = new TextEncoder().encode(JSON.stringify({ v: 7, id: 'OTHERDEVICE:1', author: 'OTHERDEVICE', seq: 1, space: 's1', extra: true }));
    expect(await t.core.ingest(raw, 'p')).toMatchObject({ status: 'parked', reason: 'unknown-version' });
    const rec = (await readPacketRecords(t.storage))[0]!;
    expect(new TextDecoder().decode(rec.raw)).toContain('"v":7'); // stored verbatim
  });

  it('applies a packet of an unknown type and a higher schema version as-is', async () => {
    const t = await createTestCore();
    const e = await remoteEnvelope({ obj: 'o1', op: 'create', type: 'martian', schemaVersion: 99, fields: { green: true } }, { seq: 1 });
    expect((await t.core.ingest(e.raw, 'p')).status).toBe('applied');
    expect(await t.core.get('o1')).toMatchObject({ type: 'martian', schemaVersion: 99, fields: { green: true } });
  });

  it('applies a parked packet after the codec arrives (revalidate)', async () => {
    const t = await createTestCore();
    const e = await remoteEnvelope({ obj: 'o1', op: 'create', type: 't', fields: { a: 1 } }, { author: 'OTHERDEVICE', seq: 1, codecId: 'late-cipher/1' });
    await t.core.ingest(e.raw, 'p');
    expect(await t.core.revalidate()).toEqual({ applied: 0, stillParked: 1 });
    t.core.registerCodec(lateCodec);
    expect(await t.core.revalidate()).toEqual({ applied: 1, stillParked: 0 });
    expect(await t.core.get('o1')).toMatchObject({ fields: { a: 1 } });
    expect((await readPacketRecords(t.storage))[0]!.status).toBe('applied');
    expect(await t.core.revalidate()).toEqual({ applied: 0, stillParked: 0 });
  });

  it('defers on a validator verdict and applies after the validator accepts', async () => {
    let allow = false;
    const gate: PacketValidator = {
      id: 'gate',
      phases: ['apply'],
      validate: () => (allow ? { verdict: 'accept' } : { verdict: 'defer', reason: 'waiting for key' }),
    };
    const t = await createTestCore({ validators: [gate] });
    const e = await remoteEnvelope({ obj: 'o1', op: 'create', type: 't', fields: { a: 1 } }, { seq: 1 });
    expect(await t.core.ingest(e.raw, 'p')).toMatchObject({ status: 'parked', reason: 'validator-deferred' });
    allow = true;
    expect(await t.core.revalidate()).toEqual({ applied: 1, stillParked: 0 });
    expect(await t.core.get('o1')).toBeDefined();
  });

  it('a validator can reject a packet outright; it is not stored and not held', async () => {
    const deny: PacketValidator = { id: 'deny', phases: ['apply'], validate: () => ({ verdict: 'reject', reason: 'nope' }) };
    const t = await createTestCore({ validators: [deny] });
    const e = await remoteEnvelope({ obj: 'o1', op: 'create', type: 't', fields: {} }, { seq: 1 });
    expect(await t.core.ingest(e.raw, 'p')).toMatchObject({ status: 'rejected', reason: 'nope' });
    expect(await readPacketRecords(t.storage)).toEqual([]);
  });

  it('applies several parked packets in clock order regardless of arrival order', async () => {
    const t = await createTestCore();
    const mk = (seq: number, wall: number, v: number) =>
      remoteEnvelope({ obj: 'o1', op: 'update', type: 't', fields: { v } }, { author: 'OTHERDEVICE', seq, wall, codecId: 'late-cipher/1' });
    const [p1, p2, p3] = [await mk(1, 100, 1), await mk(2, 200, 2), await mk(3, 300, 3)];
    for (const e of [p3, p1, p2]) await t.core.ingest(e!.raw, 'p');
    t.core.registerCodec(lateCodec);
    expect((await t.core.revalidate()).applied).toBe(3);
    expect((await t.core.get('o1'))!.fields.v).toBe(3);
  });

  it('relays parked packets to other peers, which then park them too', async () => {
    const p = await createPeers(['a', 'b', 'c'], { spaces: ['s1'] });
    const e = await remoteEnvelope({ obj: 'o1', op: 'create', type: 't', fields: { a: 1 } }, { author: 'OTHERDEVICE', seq: 1, codecId: 'late-cipher/1' });
    p.link('a', 'b');
    p.link('b', 'c');
    await p.core('a').ingest(e.raw, 'external');
    await waitFor(async () => (await readPacketRecords(p.peers.c!.storage)).some((r) => r.id === e.env.id), 5000, 'parked packet to reach c via b');
    expect((await readPacketRecords(p.peers.c!.storage))[0]!.status).toBe('parked');
    // once c learns the codec, it can read what it could only carry before
    p.core('c').registerCodec(lateCodec);
    expect((await p.core('c').revalidate()).applied).toBe(1);
    expect(await p.core('c').get('o1')).toBeDefined();
  });
});
