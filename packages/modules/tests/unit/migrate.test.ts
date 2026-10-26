// T094: migration helpers decide by clock (research R-07).
import { describe, expect, it } from 'vitest';
import type { JSONValue } from '@sync/core';
import { clockedFields } from '../../src/schema/clocked';
import { derive, isDerived, migrate } from '../../src/schema/migrate';

type Row = { v?: JSONValue; c: string };
const view = (rows: Record<string, Row>) => clockedFields(new Map(Object.entries(rows).map(([k, r]) => [k, { value: r.v, clock: r.c }])));
const flat = (r: ReturnType<ReturnType<typeof migrate.rename>>) => Object.fromEntries(Object.entries(r).map(([k, x]) => [k, isDerived(x) ? { value: x.value, clock: x.clock } : x]));

describe('rename', () => {
  const up = migrate.rename('title', 'name');
  it('takes the old value (and its clock) when only the old field was written', () => {
    expect(flat(up(view({ title: { v: 'a', c: 'c3' } }), view({})))).toEqual({ name: { value: 'a', clock: 'c3' } });
  });
  it('takes the old value when it was written after the new one', () => {
    expect(flat(up(view({ title: { v: 'old', c: 'c5' } }), view({ name: { v: 'new', c: 'c3' } })))).toEqual({ name: { value: 'old', clock: 'c5' } });
  });
  it('leaves the new value alone when it is newer, or when the clocks tie', () => {
    expect(up(view({ title: { v: 'old', c: 'c3' } }), view({ name: { v: 'new', c: 'c5' } }))).toEqual({});
    expect(up(view({ title: { v: 'old', c: 'c4' } }), view({ name: { v: 'new', c: 'c4' } }))).toEqual({});
  });
  it('a later removal of the old field removes the new one', () => {
    expect(flat(up(view({ title: { v: undefined, c: 'c9' } }), view({ name: { v: 'new', c: 'c3' } })))).toEqual({ name: { value: undefined, clock: 'c9' } });
  });
  it('does nothing when the old field was never written', () => {
    expect(up(view({}), view({ name: { v: 'new', c: 'c1' } }))).toEqual({});
  });
  it('is idempotent: the same inputs give the same result', () => {
    const p = view({ title: { v: 'a', c: 'c3' } });
    const o = view({ name: { v: 'b', c: 'c1' } });
    expect(flat(up(p, o))).toEqual(flat(up(p, o)));
  });
});

describe('convert', () => {
  const up = migrate.convert('stars', 'rating', (v) => (v as number) * 2);
  it('converts a set value, with the old write’s clock', () => {
    expect(flat(up(view({ stars: { v: 3, c: 'c2' } }), view({})))).toEqual({ rating: { value: 6, clock: 'c2' } });
  });
  it('does not call the function for a removed field', () => {
    let calls = 0;
    const u = migrate.convert('stars', 'rating', (v) => (calls++, v));
    expect(flat(u(view({ stars: { v: undefined, c: 'c2' } }), view({})))).toEqual({ rating: { value: undefined, clock: 'c2' } });
    expect(calls).toBe(0);
  });
  it('lets a later native write win', () => {
    expect(up(view({ stars: { v: 3, c: 'c2' } }), view({ rating: { v: 9, c: 'c7' } }))).toEqual({});
  });
});

describe('addDefault', () => {
  const up = migrate.addDefault('priority', 0);
  it('adds the default, with a clock older than any real write', () => {
    const r = up(view({}), view({})).priority;
    expect(isDerived(r)).toBe(true);
    expect(r).toMatchObject({ value: 0, clock: '' });
  });
  it('does nothing once the field was ever written, even if it was later removed', () => {
    expect(up(view({}), view({ priority: { v: 5, c: 'c1' } }))).toEqual({});
    expect(up(view({ priority: { v: undefined, c: 'c1' } }), view({}))).toEqual({});
  });
});

describe('all', () => {
  it('merges independent steps run on the same inputs, a later step winning on the same field', () => {
    const up = migrate.all(migrate.rename('title', 'name'), migrate.addDefault('priority', 0), migrate.rename('label', 'name'));
    const r = flat(up(view({ title: { v: 'T', c: 'c3' }, label: { v: 'L', c: 'c4' } }), view({})));
    expect(r).toMatchObject({ name: { value: 'L', clock: 'c4' }, priority: { value: 0, clock: '' } });
  });
  it('with no steps does nothing', () => {
    expect(migrate.all()(view({}), view({}))).toEqual({});
  });
});

describe('mirrorRename (for down)', () => {
  it('writes the old name whenever the new one is written, and says nothing otherwise', () => {
    const down = migrate.mirrorRename('name', 'title');
    expect(down({ name: 'x', done: true })).toEqual({ title: 'x' });
    expect(down({ done: true })).toEqual({});
    expect(down({ name: { $unset: true } })).toEqual({ title: { $unset: true } });
  });
});

describe('derive', () => {
  it('is recognizable and cannot be forged by JSON data', () => {
    expect(isDerived(derive(1, 'c'))).toBe(true);
    expect(isDerived({ value: 1, clock: 'c' })).toBe(false);
    expect(isDerived(JSON.parse('{"value":1,"clock":"c"}'))).toBe(false);
    expect(isDerived(null)).toBe(false);
  });
});
