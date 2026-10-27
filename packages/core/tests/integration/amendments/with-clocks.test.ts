// T009 (C-2, spec 003): per-field clocks on reads, only on request.
import { describe, expect, it } from 'vitest';
import { createTestCore } from '@sync/testkit';

describe('C-2 withClocks', () => {
  it('returns the clock of the last write per field, matching history()', async () => {
    const t = await createTestCore();
    const o = await t.core.create('s1', 'note', { a: 1, b: 1 });
    t.clock.advance(10);
    await t.core.update(o.id, { b: 2 });
    const h = await t.core.history(o.id);
    const got = await t.core.get(o.id, { withClocks: true });
    expect(got!.clocks).toEqual({ a: h[0]!.clock, b: h[1]!.clock });
    const [viaQuery] = await t.core.query({ id: o.id, withClocks: true }).once();
    expect(viaQuery!.clocks).toEqual(got!.clocks);
  });

  it('is absent by default, so existing results are unchanged', async () => {
    const t = await createTestCore();
    const o = await t.core.create('s1', 'note', { a: 1 });
    expect('clocks' in (await t.core.get(o.id))!).toBe(false);
    const [r] = await t.core.query({ type: 'note' }).once();
    expect('clocks' in r!).toBe(false);
    expect('clocks' in o).toBe(false);
  });

  it('does not list unset fields in fields but keeps their clock', async () => {
    const t = await createTestCore();
    const o = await t.core.create('s1', 'note', { a: 1, b: 2 });
    t.clock.advance(10);
    const { UNSET } = await import('@sync/core');
    await t.core.update(o.id, { b: UNSET });
    const got = await t.core.get(o.id, { withClocks: true });
    expect(got!.fields).toEqual({ a: 1 });
    expect(Object.keys(got!.clocks!).sort()).toEqual(['a', 'b']);
  });
});
