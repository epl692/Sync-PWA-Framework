// T100 (US6): v1 and v2 peers in the same network (acceptance scenarios US6-1 to US6-3).
import { describe, expect, it } from 'vitest';
import { createPeers, remoteEnvelope, waitFor } from '@sync/testkit';
import { createHost } from '../../src/host/host';
import type { DataFacade, ModuleDefinition } from '../../src/types';
import { appV1, appV2, appV2NoDown } from '../property/mixed-versions/schema';

const quiet = { info() {}, warn() {}, error() {} };

async function network(spec: Record<string, ModuleDefinition | undefined>) {
  const names = Object.keys(spec);
  const p = await createPeers(names, { spaces: ['s1'] });
  const data: Record<string, DataFacade> = {};
  for (const n of names) {
    const def = spec[n];
    if (!def) continue; // a peer with no modules at all
    const host = createHost({ core: p.core(n), entries: [{ def, source: 'bundled' }], defineViews: false, log: quiet });
    await host.start();
    await host.closeBootWindow();
    data[n] = host.contextOf('app')!.data;
  }
  return { p, data };
}
const settle = (p: Awaited<ReturnType<typeof createPeers>>) => p.converged('s1');

describe('a v1 peer receiving v2 packets', () => {
  it('stores and relays them, shows what it knows, and its own edits never overwrite v2 fields', async () => {
    const { p, data } = await network({ a: appV2, b: appV1, c: undefined });
    p.link('a', 'b');
    p.link('b', 'c');

    const o = await data.a!.create('s1', 'app.item', { name: 'oat', priority: 3 }, { id: 'o1' });
    p.peers.a!.clock.advance(10);
    await data.a!.update(o.id, { name: 'oat milk', priority: 4 });
    await settle(p);

    // b (v1): nothing was refused; it shows its own version's fields (and sees the rename, because the writer mirrored it)
    expect(p.peers.b!.core).toBeDefined();
    const onB = await data.b!.get('o1');
    expect(onB!.fields).toEqual({ title: 'oat milk', done: false });
    expect(onB!.seenVersion).toBe(2);
    // ... and it kept the fields it cannot show
    expect((await p.core('b').get('o1'))!.fields).toMatchObject({ name: 'oat milk', priority: 4, title: 'oat milk', done: false });
    // c has no modules at all, and still got everything through b
    expect((await p.core('c').get('o1'))!.fields).toMatchObject({ name: 'oat milk', priority: 4, title: 'oat milk' });

    // b edits a v1 field; the v2 fields are untouched, and a sees the edit under its own names
    p.peers.b!.clock.advance(1000);
    await data.b!.update('o1', { title: 'milk' });
    await settle(p);
    const onA = await data.a!.get('o1');
    expect(onA!.fields).toEqual({ name: 'milk', done: false, priority: 4 });
    expect((await p.core('b').get('o1'))!.fields.priority).toBe(4);
  });

  it('without a down, it still stores and keeps everything, but does not see the renamed field change', async () => {
    const { p, data } = await network({ a: appV2NoDown, b: appV1 });
    p.link('a', 'b');
    await data.b!.create('s1', 'app.item', { title: 'first' }, { id: 'o1' });
    await settle(p);
    p.peers.a!.clock.advance(1000);
    await data.a!.update('o1', { name: 'second', priority: 2 });
    await settle(p);
    expect((await data.b!.get('o1'))!.fields.title).toBe('first'); // v1 does not see the rename
    expect((await p.core('b').get('o1'))!.fields).toMatchObject({ name: 'second', priority: 2 }); // but keeps it
    expect((await data.a!.get('o1'))!.fields.name).toBe('second');
  });
});

describe('a v2 peer receiving v1 packets', () => {
  it('validates them against version 1, applies them, and shows them in version 2 names', async () => {
    const { p, data } = await network({ a: appV2, b: appV1 });
    p.link('a', 'b');
    await data.b!.create('s1', 'app.item', { title: 'v1 thing' }, { id: 'o2' });
    await settle(p);
    const onA = await data.a!.get('o2');
    expect(onA).toMatchObject({ fields: { name: 'v1 thing', done: false, priority: 0 }, seenVersion: 1 });
    expect(Object.keys((await p.core('a').get('o2'))!.fields).sort()).toEqual(['done', 'title']); // stored exactly as written
  });

  it('refuses a version 1 packet that uses a name version 1 does not have', async () => {
    const { p } = await network({ a: appV2 });
    const bad = await remoteEnvelope({ obj: 'o3', op: 'create', type: 'app.item', schemaVersion: 1, fields: { name: 'x' } }, { seq: 1 });
    expect(await p.core('a').ingest(bad.raw, 'peer')).toMatchObject({ status: 'rejected', reason: expect.stringContaining('unknown-field') });
    const fine = await remoteEnvelope({ obj: 'o3', op: 'create', type: 'app.item', schemaVersion: 2, fields: { name: 'x' } }, { seq: 2 });
    expect(await p.core('a').ingest(fine.raw, 'peer')).toMatchObject({ status: 'applied' });
  });

  it('a v2 edit of a field that a v1 peer created writes at version 2, so every peer validates it', async () => {
    const { p, data } = await network({ a: appV2, b: appV1 });
    p.link('a', 'b');
    await data.b!.create('s1', 'app.item', { title: 'made by v1' }, { id: 'o4' }); // the object is at version 1
    await settle(p);
    p.peers.a!.clock.advance(100);
    await data.a!.update('o4', { name: 'edited by v2', priority: 7 }); // names version 1 does not have
    await settle(p);
    expect(p.peers.a!.core).toBeDefined();
    expect((await p.core('b').get('o4'))!.schemaVersion).toBe(2);
    await waitFor(async () => (await data.b!.get('o4'))?.fields.title === 'edited by v2', 3000, 'v1 sees the mirrored title');
    expect((await data.a!.get('o4'))!.fields).toMatchObject({ name: 'edited by v2', priority: 7 });
  });
});
