// T031: the data facade over a module's own types (no access checks yet; those arrive with US5).
import { describe, expect, it } from 'vitest';
import { createTestCore } from '@sync/testkit';
import { UNSET } from '@sync/core';
import { createFacade } from '../../src/access/facade';
import { SchemaRegistry } from '../../src/schema/registry';
import { simpleType } from '../helpers';

async function setup() {
  const t = await createTestCore();
  const registry = new SchemaRegistry();
  registry.register('todo', simpleType('item'));
  const facade = createFacade({ core: t.core, registry, moduleId: 'todo', emit: () => {} });
  return { t, registry, facade };
}

describe('data facade', () => {
  it('creates, gets, updates and removes projected objects', async () => {
    const { facade } = await setup();
    const o = await facade.create('s1', 'todo.item', { title: 'milk', done: false });
    expect(o).toMatchObject({ type: 'todo.item', space: 's1', fields: { title: 'milk', done: false }, seenVersion: 1 });
    expect((await facade.get(o.id))!.fields.title).toBe('milk');
    const u = await facade.update(o.id, { title: 'oat milk' });
    expect(u.fields).toEqual({ title: 'oat milk', done: false });
    await facade.update(o.id, { done: UNSET });
    expect((await facade.get(o.id))!.fields).toEqual({ title: 'oat milk' });
    await facade.remove(o.id);
    expect(await facade.get(o.id)).toBeUndefined();
  });

  it('writes at the latest schema version', async () => {
    const t = await createTestCore();
    const registry = new SchemaRegistry();
    registry.register('todo', {
      name: 'item',
      versions: [
        { version: 1, fields: { title: { type: 'string' } } },
        { version: 2, fields: { name: { type: 'string' } }, up: () => ({}), breaking: true },
      ],
    });
    const facade = createFacade({ core: t.core, registry, moduleId: 'todo', emit: () => {} });
    const o = await facade.create('s1', 'todo.item', { name: 'x' });
    expect((await t.core.get(o.id))!.schemaVersion).toBe(2);
  });

  it('refuses to create an object of an unregistered type', async () => {
    const { facade } = await setup();
    await expect(facade.create('s1', 'todo.ghost', { a: 1 })).rejects.toThrow(/todo\.ghost.*not registered/);
  });

  it('queries by type: subscribe, once and async iteration give projected rows', async () => {
    const { facade } = await setup();
    await facade.create('s1', 'todo.item', { title: 'a' });
    await facade.create('s2', 'todo.item', { title: 'b' });
    const q = facade.query({ type: 'todo.item', space: 's1' });
    const once = await q.once();
    expect(once.map((r) => r.fields.title)).toEqual(['a']);
    const seen: string[][] = [];
    const unsub = q.subscribe((rows) => seen.push(rows.map((r) => String(r.fields.title))));
    expect(seen).toEqual([['a']]);
    await facade.create('s1', 'todo.item', { title: 'c' });
    await Promise.resolve();
    await Promise.resolve();
    expect(seen.at(-1)).toEqual(['a', 'c']);
    unsub();
    for await (const rows of q) {
      expect(rows.map((r) => r.fields.title)).toEqual(['a', 'c']);
      break;
    }
  });

  it('applies a where predicate to projected objects', async () => {
    const { facade } = await setup();
    await facade.create('s1', 'todo.item', { title: 'a', done: true });
    await facade.create('s1', 'todo.item', { title: 'b', done: false });
    const rows = await facade.query({ type: 'todo.item', where: (o) => o.fields.done === true }).once();
    expect(rows.map((r) => r.fields.title)).toEqual(['a']);
  });

  it('requires a type or an id to query', async () => {
    const { facade } = await setup();
    expect(() => facade.query({ space: 's1' })).toThrow(/type or an id/);
    expect(() => facade.query({})).toThrow(/type or an id/);
    const o = await facade.create('s1', 'todo.item', { title: 'a' });
    expect((await facade.query({ id: o.id }).once()).map((r) => r.id)).toEqual([o.id]);
  });

  it('does not expose objects of types the registry does not know', async () => {
    const { t, facade } = await setup();
    const raw = await t.core.create('s1', 'other.thing', { x: 1 });
    expect(await facade.get(raw.id)).toBeUndefined();
    expect(await facade.query({ id: raw.id }).once()).toEqual([]);
    expect(await facade.query({ type: 'other.thing' }).once()).toEqual([]);
  });

  it('undoes through the core, and exposes history', async () => {
    const { t, facade } = await setup();
    const o = await facade.create('s1', 'todo.item', { title: 'a' });
    t.clock.advance(10);
    await facade.update(o.id, { title: 'b' });
    t.clock.advance(10);
    await facade.undo(o.id);
    expect((await facade.get(o.id))!.fields.title).toBe('a');
    expect((await facade.history(o.id)).map((h) => h.op)).toEqual(['create', 'update', 'update']);
  });

  it('hides $-prefixed system objects', async () => {
    const { t, facade } = await setup();
    const sys = await t.core.create('s1', '$sys.x', { a: 1 });
    expect(await facade.get(sys.id)).toBeUndefined();
  });
});
