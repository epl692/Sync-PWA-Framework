// T009 (B-3, spec 004): onApplied carries the post-apply object, so consumers need not guess state from packet fields.
import { describe, expect, it } from 'vitest';
import { createTestCore, remoteEnvelope } from '@sync/testkit';

const REMOTE = 'REMOTEAAAAAAAAAAAAAAAAAAA';

describe('B-3 onApplied object', () => {
  it('carries the object after create, update and delete', async () => {
    const t = await createTestCore();
    const seen: Array<{ op: string; fields: unknown }> = [];
    t.core.onApplied((e) => seen.push({ op: e.body.op, fields: e.object?.fields }));
    const o = await t.core.create('s1', 'item', { a: 1, b: 1 });
    t.clock.advance(10);
    await t.core.update(o.id, { b: 2 });
    t.clock.advance(10);
    await t.core.remove(o.id);
    expect(seen).toEqual([
      { op: 'create', fields: { a: 1, b: 1 } },
      { op: 'update', fields: { a: 1, b: 2 } }, // the packet carried only b
      { op: 'delete', fields: { a: 1, b: 2 } }, // the tombstoned object keeps its fields
    ]);
  });

  it('reports the current object for an update that lost last-writer-wins', async () => {
    const t = await createTestCore();
    t.clock.advance(1_000_000);
    const o = await t.core.create('s1', 'item', { a: 'new' }, { id: 'o1' });
    const seen: unknown[] = [];
    t.core.onApplied((e) => seen.push(e.object?.fields));
    const old = await remoteEnvelope({ obj: o.id, op: 'update', type: 'item', fields: { a: 'old' } }, { author: REMOTE, seq: 1, wall: 1_700_000_000_000 - 10_000_000 });
    await t.core.ingest(old.raw, 'peer');
    expect(seen).toEqual([{ a: 'new' }]);
  });

  it('carries the object for a parked packet applied later', async () => {
    const t = await createTestCore();
    let defer = true;
    t.core.registerValidator({ id: 'd', phases: ['apply'], validate: () => (defer ? { verdict: 'defer', reason: 'x' } : { verdict: 'accept' }) });
    const seen: unknown[] = [];
    t.core.onApplied((e) => seen.push(e.object?.fields));
    const r = await remoteEnvelope({ obj: 'r1', op: 'create', type: 'item', fields: { k: 'v' } }, { author: REMOTE, seq: 1 });
    await t.core.ingest(r.raw, 'peer');
    expect(seen).toEqual([]);
    defer = false;
    await t.core.revalidate();
    expect(seen).toEqual([{ k: 'v' }]);
  });

  it('is ignorable: a consumer that reads only env, body and source is unaffected', async () => {
    const t = await createTestCore();
    const seen: string[] = [];
    t.core.onApplied(({ env, body, source }) => seen.push(`${source}:${body.obj}:${env.id.length > 0}`));
    await t.core.create('s1', 'item', {}, { id: 'x' });
    expect(seen).toEqual(['local:x:true']);
  });
});
