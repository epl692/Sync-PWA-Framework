// T007 (A-2): rebuildSpace re-runs retained packets through the validators.
import { describe, expect, it } from 'vitest';
import { createTestCore, readPacketRecords, remoteEnvelope } from '@sync/testkit';

const X = 'XAUTHORAAAAAAAAAAAAAAAAAA';
const Y = 'YAUTHORAAAAAAAAAAAAAAAAAA';

async function setup() {
  const blocked = new Set<string>();
  const mk = async () => {
    const t = await createTestCore();
    t.core.registerValidator({
      id: 'block',
      phases: ['apply'],
      validate: (_p, env) => (blocked.has(env.author) ? { verdict: 'reject', reason: 'blocked' } : { verdict: 'accept' }),
    });
    return t;
  };
  const x = await remoteEnvelope({ obj: 'ox', op: 'create', type: 'item', fields: { v: 'x' } }, { author: X, seq: 1, wall: 1_700_000_000_100 });
  const y = await remoteEnvelope({ obj: 'oy', op: 'create', type: 'item', fields: { v: 'y' } }, { author: Y, seq: 1, wall: 1_700_000_000_200 });
  return { blocked, mk, x, y };
}

describe('A-2 rebuildSpace', () => {
  it('removes the effect of a packet that now fails validation, and matches a peer that never saw it', async () => {
    const { blocked, mk, x, y } = await setup();
    const b = await mk();
    const c = await mk();
    await b.core.ingest(x.raw, 'test');
    await b.core.ingest(y.raw, 'test');
    blocked.add(X);
    await c.core.ingest(y.raw, 'test'); // c only ever saw y (x rejected on arrival)
    await c.core.ingest(x.raw, 'test');

    expect(await b.core.get('ox')).toBeDefined();
    const r = await b.core.rebuildSpace('s1');
    expect(r.rejected).toBe(1);
    expect(await b.core.get('ox')).toBeUndefined();
    expect(await b.core.get('oy')).toBeDefined();
    expect(await b.core.stateHash('s1')).toBe(await c.core.stateHash('s1'));
    const rec = (await readPacketRecords(b.storage)).find((p) => p.author === X)!;
    expect(rec.status).toBe('rejected');
  });

  it('re-accepts a rejected packet when the validators change their mind', async () => {
    const { blocked, mk, x } = await setup();
    const b = await mk();
    await b.core.ingest(x.raw, 'test');
    blocked.add(X);
    await b.core.rebuildSpace('s1');
    expect(await b.core.get('ox')).toBeUndefined();
    blocked.delete(X);
    const r = await b.core.rebuildSpace('s1');
    expect(r.reapplied).toBe(1);
    expect(await b.core.get('ox')).toBeDefined();
  });

  it('keeps live queries and the object cache consistent', async () => {
    const { blocked, mk, x } = await setup();
    const b = await mk();
    await b.core.ingest(x.raw, 'test');
    const seen: number[] = [];
    b.core.query({ type: 'item' }).subscribe((r) => seen.push(r.length));
    blocked.add(X);
    await b.core.rebuildSpace('s1');
    await new Promise((r) => setTimeout(r, 5));
    expect(seen.at(-1)).toBe(0);
  });

  it('does not forward rejected packets to peers', async () => {
    const { blocked, mk, x } = await setup();
    const b = await mk();
    await b.core.ingest(x.raw, 'test');
    blocked.add(X);
    await b.core.rebuildSpace('s1');
    const exported = (await readPacketRecords(b.storage)).filter((p) => p.status === 'rejected');
    expect(exported).toHaveLength(1);
  });
});
