// T096: mirroring writes into older versions' names with `down`, and the breaking event.
import { describe, expect, it } from 'vitest';
import { createTestCore } from '@sync/testkit';
import { createHost } from '../../src/host/host';
import { migrate } from '../../src/schema/migrate';
import { prepareWrite } from '../../src/schema/prepare-write';
import { SchemaRegistry } from '../../src/schema/registry';
import type { ObjectTypeDef } from '../../src/schema/types';
import type { HostEvent } from '../../src/types';

const v1 = { version: 1, fields: { title: { type: 'string' as const }, done: { type: 'boolean' as const, default: false } } };
const v2 = {
  version: 2,
  fields: { name: { type: 'string' as const }, done: { type: 'boolean' as const, default: false }, tag: { type: 'string' as const } },
  up: migrate.rename('title', 'name'),
  down: migrate.mirrorRename('name', 'title'),
};
const v3 = {
  version: 3,
  fields: { label: { type: 'string' as const }, done: { type: 'boolean' as const, default: false }, tag: { type: 'string' as const } },
  up: migrate.rename('name', 'label'),
  down: migrate.mirrorRename('label', 'name'),
};
const reg = (def: Partial<ObjectTypeDef> & { versions: ObjectTypeDef['versions'] }) => new SchemaRegistry().register('m', { name: 'item', ...def });

describe('prepareWrite with down', () => {
  it('a version 2 write also carries the version 1 name, in the same packet, still written at version 2', () => {
    const r = prepareWrite(reg({ versions: [v1, v2] }), 'update', { name: 'oat' });
    expect(r).toEqual({ schemaVersion: 2, fields: { name: 'oat', title: 'oat' } });
  });

  it('a create mirrors too, defaults included', () => {
    expect(prepareWrite(reg({ versions: [v1, v2] }), 'create', { name: 'oat' }).fields).toEqual({ name: 'oat', done: false, title: 'oat' });
  });

  it('writes nothing extra for fields a down does not map', () => {
    expect(prepareWrite(reg({ versions: [v1, v2] }), 'update', { tag: 'x' }).fields).toEqual({ tag: 'x' });
  });

  it('a removal is mirrored as a removal', () => {
    expect(prepareWrite(reg({ versions: [v1, v2] }), 'update', { name: { $unset: true } }).fields).toEqual({ name: { $unset: true }, title: { $unset: true } });
  });

  it('by default mirrors one version back; compatWrite widens it', () => {
    const three = [v1, v2, v3];
    expect(prepareWrite(reg({ versions: three }), 'update', { label: 'x' }).fields).toEqual({ label: 'x', name: 'x' });
    expect(prepareWrite(reg({ versions: three, compatWrite: 1 }), 'update', { label: 'x' }).fields).toEqual({ label: 'x', name: 'x', title: 'x' });
    expect(prepareWrite(reg({ versions: three, compatWrite: 3 }), 'update', { label: 'x' }).fields).toEqual({ label: 'x' });
  });

  it('without a down nothing is mirrored', () => {
    const noDown = { ...v2, down: undefined, breaking: true };
    expect(prepareWrite(reg({ versions: [v1, noDown] }), 'update', { name: 'oat' }).fields).toEqual({ name: 'oat' });
  });

  it('what the caller wrote wins over a mirror of the same name', () => {
    const odd = { ...v2, down: () => ({ done: true }) };
    expect(prepareWrite(reg({ versions: [v1, odd] }), 'update', { name: 'x', done: false }).fields).toEqual({ name: 'x', done: false });
  });

  it('a down that throws is reported with the type and version', () => {
    // (the lint test-runs `down` with sample values, so this one only fails on a real value)
    const bad = { ...v2, down: (c: Record<string, unknown>) => { if (c.name === 'x') throw new Error('nope'); return {}; } };
    expect(() => prepareWrite(reg({ versions: [v1, bad] }), 'update', { name: 'x' })).toThrow(/down\(\) of m\.item version 2 threw: nope/);
  });

  it('does not mutate its input', () => {
    const input = { name: 'x' };
    prepareWrite(reg({ versions: [v1, v2] }), 'update', input);
    expect(input).toEqual({ name: 'x' });
  });
});

describe('schema:breaking', () => {
  const breaking = { version: 2, fields: { name: { type: 'string' as const } }, up: migrate.rename('title', 'name'), breaking: true };

  it('is emitted once per type and version per host, naming the type and version', async () => {
    const t = await createTestCore();
    const events: HostEvent[] = [];
    const host = createHost({
      core: t.core,
      entries: [{ def: { id: 'app', version: '1.0.0', provides: { types: [{ name: 'item', versions: [v1, breaking] }, { name: 'other', versions: [v1] }] } }, source: 'bundled' }],
      defineViews: false,
      log: { info() {}, warn() {}, error() {} },
    });
    host.on((e) => void events.push(e));
    await host.start();
    expect(events.filter((e) => e.kind === 'schema:breaking')).toEqual([{ kind: 'schema:breaking', type: 'app.item', version: 2 }]);
  });
});
