// T028: reactive queries.
import { describe, expect, it } from 'vitest';
import { createTestCore, flush, remoteEnvelope } from '@sync/testkit';

describe('reactive queries', () => {
  it('emits the current result immediately, then after each relevant change', async () => {
    const t = await createTestCore();
    const results: string[][] = [];
    const unsub = t.core.query({ type: 'note' }).subscribe((r) => results.push(r.map((o) => o.fields.t as string)));
    expect(results).toEqual([[]]);
    await t.core.create('s1', 'note', { t: 'one' });
    await flush();
    await t.core.create('s1', 'other', { t: 'ignored' });
    await flush();
    await t.core.create('s1', 'note', { t: 'two' });
    await flush();
    expect(results).toEqual([[], ['one'], ['one', 'two']]);
    unsub();
    await t.core.create('s1', 'note', { t: 'three' });
    await flush();
    expect(results).toHaveLength(3);
  });

  it('supports queries by id and by where predicate', async () => {
    const t = await createTestCore();
    const a = await t.core.create('s1', 'item', { n: 1 });
    await t.core.create('s1', 'item', { n: 5 });
    expect((await t.core.query({ id: a.id }).once()).map((o) => o.id)).toEqual([a.id]);
    const big = await t.core.query({ type: 'item', where: (o) => (o.fields.n as number) > 3 }).once();
    expect(big.map((o) => o.fields.n)).toEqual([5]);
    expect(await t.core.query({ type: 'item', space: 'elsewhere' }).once()).toEqual([]);
  });

  it('updates a by-id query when the object changes and when it is deleted', async () => {
    const t = await createTestCore();
    const o = await t.core.create('s1', 'item', { n: 1 });
    const seen: (number | undefined)[] = [];
    t.core.query({ id: o.id }).subscribe((r) => seen.push(r[0]?.fields.n as number | undefined));
    await t.core.update(o.id, { n: 2 });
    await flush();
    await t.core.remove(o.id);
    await flush();
    expect(seen).toEqual([1, 2, undefined]);
  });

  it('does not emit when a duplicate packet changes nothing (Story 2 scenario 3)', async () => {
    const t = await createTestCore();
    let emits = 0;
    t.core.query({ type: 't' }).subscribe(() => emits++);
    const e = await remoteEnvelope({ obj: 'o1', op: 'create', type: 't', fields: { a: 1 } }, { seq: 1 });
    await t.core.ingest(e.raw, 'p');
    await flush();
    const after = emits;
    await t.core.ingest(e.raw, 'p');
    await flush();
    expect(emits).toBe(after);
  });

  it('does not emit when a losing (older) field value arrives', async () => {
    const t = await createTestCore();
    const newer = await remoteEnvelope({ obj: 'o1', op: 'create', type: 't', fields: { a: 'new' } }, { seq: 1, wall: 5000 });
    const older = await remoteEnvelope({ obj: 'o1', op: 'update', type: 't', fields: { a: 'old' } }, { seq: 2, wall: 1000 });
    await t.core.ingest(newer.raw, 'p');
    let emits = 0;
    t.core.query({ type: 't' }).subscribe(() => emits++);
    await t.core.ingest(older.raw, 'p');
    await flush();
    expect(emits).toBe(1); // only the initial emit
  });

  it('coalesces a batch of changes into a single emission', async () => {
    const t = await createTestCore();
    let emits = 0;
    t.core.query({ type: 't' }).subscribe(() => emits++);
    const envs = await Promise.all(
      Array.from({ length: 20 }, (_, i) => remoteEnvelope({ obj: `o${i}`, op: 'create', type: 't', fields: { i } }, { seq: i + 1 })),
    );
    await t.core.ingestBatch(envs.map((e) => e.raw), 'p');
    await flush();
    expect(emits).toBe(2); // the initial result, then one for the whole batch
    expect(await t.core.query({ type: 't' }).once()).toHaveLength(20);
  });

  it('is also an async iterable of results', async () => {
    const t = await createTestCore();
    const it = t.core.query({ type: 'note' })[Symbol.asyncIterator]();
    expect((await it.next()).value).toEqual([]);
    const next = it.next();
    await t.core.create('s1', 'note', { t: 'x' });
    expect(((await next).value as { fields: { t: string } }[]).map((o) => o.fields.t)).toEqual(['x']);
  });
});
