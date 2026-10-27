// T051 (US2): validation across peers, newer versions, and deferral of unknown types.
import { describe, expect, it } from 'vitest';
import { createPeers, readOutbox, readPacketRecords, remoteEnvelope, waitFor } from '@sync/testkit';
import { createHost } from '../../src/host/host';
import { createFacade } from '../../src/access/facade';
import { SchemaValidationError } from '../../src/schema/types';
import type { HostEvent, ModuleDefinition } from '../../src/types';

const notes: ModuleDefinition = {
  id: 'notes',
  version: '1.0.0',
  provides: { types: [{ name: 'item', versions: [{ version: 1, fields: { title: { type: 'string', required: true, maxLength: 5 } } }] }] },
};
const quiet = { info() {}, warn() {}, error() {} };

async function hosted(names: string[], plain: string[] = []) {
  const p = await createPeers([...names, ...plain], { spaces: ['s1'] });
  const hosts: Record<string, Awaited<ReturnType<typeof start>>> = {};
  const start = async (n: string) => {
    const host = createHost({ core: p.core(n), entries: [{ def: notes, source: 'bundled' }], defineViews: false, log: quiet });
    await host.start();
    const events: HostEvent[] = [];
    const facade = createFacade({ core: p.core(n), registry: host.registry, moduleId: 'notes', emit: (e) => void events.push(e) });
    return { host, facade, events };
  };
  for (const n of names) hosts[n] = await start(n);
  return { p, hosts };
}

describe('local writes', () => {
  it('a violating write throws SchemaValidationError and creates no packet', async () => {
    const { p, hosts } = await hosted(['a']);
    const err = await hosts.a!.facade.create('s1', 'notes.item', { title: 'toolong' }).catch((e) => e);
    expect(err).toBeInstanceOf(SchemaValidationError);
    expect(err).toMatchObject({ type: 'notes.item', field: 'title' });
    expect(await readPacketRecords(p.peers.a!.storage)).toEqual([]);
    expect(await readOutbox(p.peers.a!.storage)).toEqual([]);
    expect(await p.core('a').query({ type: 'notes.item' }).once()).toEqual([]);
  });

  it('missing required fields and unknown fields are refused too; an update cannot unset a required field', async () => {
    const { hosts } = await hosted(['a']);
    const f = hosts.a!.facade;
    await expect(f.create('s1', 'notes.item', {})).rejects.toBeInstanceOf(SchemaValidationError);
    await expect(f.create('s1', 'notes.item', { title: 'ok', stray: 1 })).rejects.toMatchObject({ field: 'stray' });
    const o = await f.create('s1', 'notes.item', { title: 'ok' });
    await expect(f.update(o.id, { title: 'toolong' })).rejects.toBeInstanceOf(SchemaValidationError);
    const { UNSET } = await import('@sync/core');
    await expect(f.update(o.id, { title: UNSET })).rejects.toBeInstanceOf(SchemaValidationError);
    expect((await f.get(o.id))!.fields.title).toBe('ok');
  });
});

describe('remote packets', () => {
  it('a violating packet is rejected and not applied, a valid one is applied', async () => {
    const { p } = await hosted(['a']);
    const bad = await remoteEnvelope({ obj: 'o1', op: 'create', type: 'notes.item', fields: { title: 'toolong' } }, { seq: 1 });
    const good = await remoteEnvelope({ obj: 'o2', op: 'create', type: 'notes.item', fields: { title: 'fine' } }, { seq: 2 });
    expect(await p.core('a').ingest(bad.raw, 'peer')).toMatchObject({ status: 'rejected' });
    expect(await p.core('a').ingest(good.raw, 'peer')).toMatchObject({ status: 'applied' });
    expect(await p.core('a').get('o1')).toBeUndefined();
    expect((await p.core('a').get('o2'))!.fields.title).toBe('fine');
  });

  it('a packet with a newer schemaVersion is applied leniently, kept, and relayed to a peer that has no modules', async () => {
    const { p, hosts } = await hosted(['b'], ['c']);
    p.link('b', 'c');
    const future = await remoteEnvelope({ obj: 'o1', op: 'create', type: 'notes.item', schemaVersion: 2, fields: { title: 'toolong', future: { x: 1 } } }, { seq: 1 });
    expect(await p.core('b').ingest(future.raw, 'peer')).toMatchObject({ status: 'applied' });
    await waitFor(async () => (await p.core('c').get('o1'))?.fields.future, 3000, 'relay to c');
    const onC = await p.core('c').get('o1');
    expect(onC!.fields).toEqual({ title: 'toolong', future: { x: 1 } });
    // b's module sees only what its schema knows, with the newer version visible
    const seen = await hosts.b!.facade.get('o1');
    expect(seen!.seenVersion).toBe(2);
    // `title` is longer than this peer's schema allows: the stored value is kept, but not shown, and reported once
    expect(seen!.fields).toEqual({});
    expect(seen!.violations).toEqual([{ field: 'title', detail: expect.stringContaining('at most 5') }]);
    await hosts.b!.facade.get('o1');
    expect(hosts.b!.events.filter((e) => e.kind === 'schema:violation')).toEqual([{ kind: 'schema:violation', type: 'notes.item', obj: 'o1', field: 'title', detail: expect.stringContaining('at most 5') }]);
  });
});

describe('unknown types and the boot window', () => {
  it('parks a packet for a type nobody registered yet, then keeps it as opaque data once the window closes', async () => {
    const { p, hosts } = await hosted(['a']);
    const early = await remoteEnvelope({ obj: 'o1', op: 'create', type: 'later.thing', fields: { x: 1 } }, { seq: 1 });
    expect(await p.core('a').ingest(early.raw, 'peer')).toMatchObject({ status: 'parked', reason: expect.stringContaining('deferred') });
    expect(await p.core('a').get('o1')).toBeUndefined();
    await hosts.a!.host.closeBootWindow();
    expect((await p.core('a').get('o1'))!.fields).toEqual({ x: 1 });
    // the module facade does not expose types it has no schema for
    expect(await hosts.a!.facade.get('o1')).toBeUndefined();
    const after = await remoteEnvelope({ obj: 'o2', op: 'create', type: 'later.thing', fields: { x: 2 } }, { seq: 2 });
    expect(await p.core('a').ingest(after.raw, 'peer')).toMatchObject({ status: 'applied' });
  });
});
