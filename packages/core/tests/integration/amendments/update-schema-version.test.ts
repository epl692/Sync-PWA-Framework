// C-3 (spec 003): an update can declare the schema version it is written at.
import { describe, expect, it } from 'vitest';
import { createTestCore, readPacketRecords } from '@sync/testkit';
import { decodeEnvelope } from '@sync/core';
import { PlaintextCodec } from '@sync/testkit';

const bodies = async (t: Awaited<ReturnType<typeof createTestCore>>) => {
  const codec = new PlaintextCodec();
  const out = [];
  for (const rec of await readPacketRecords(t.storage)) {
    const { env } = decodeEnvelope(rec.raw);
    const r = await codec.decode(env.body, { space: env.space, author: env.author });
    if (r.ok) out.push(r.body);
  }
  return out;
};

describe('C-3 update schemaVersion', () => {
  it('writes the packet at the requested version and raises the object version', async () => {
    const t = await createTestCore();
    const o = await t.core.create('s1', 'm.item', { title: 'a' }, { schemaVersion: 1 });
    t.clock.advance(10);
    await t.core.update(o.id, { name: 'b' }, { schemaVersion: 2 });
    expect((await t.core.get(o.id))!.schemaVersion).toBe(2);
    const b = await bodies(t);
    expect(b.map((x) => x.schemaVersion).sort()).toEqual([1, 2]);
  });

  it('defaults to the version the object already has', async () => {
    const t = await createTestCore();
    const o = await t.core.create('s1', 'm.item', { title: 'a' }, { schemaVersion: 3 });
    t.clock.advance(10);
    await t.core.update(o.id, { title: 'b' });
    expect((await bodies(t)).map((x) => x.schemaVersion)).toEqual([3, 3]);
  });

  it('a lower version never lowers the object version (merge keeps the maximum)', async () => {
    const t = await createTestCore();
    const o = await t.core.create('s1', 'm.item', { title: 'a' }, { schemaVersion: 2 });
    t.clock.advance(10);
    await t.core.update(o.id, { title: 'b' }, { schemaVersion: 1 });
    expect((await t.core.get(o.id))!.schemaVersion).toBe(2);
  });
});
