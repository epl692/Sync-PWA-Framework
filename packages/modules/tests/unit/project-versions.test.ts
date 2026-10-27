// T095: projecting stored objects through the version chain (research R-07).
import { describe, expect, it } from 'vitest';
import type { SyncableObject } from '@sync/core';
import { SchemaRegistry } from '../../src/schema/registry';
import { migrate } from '../../src/schema/migrate';
import { project } from '../../src/schema/project';
import type { ObjectTypeDef } from '../../src/schema/types';

const def: ObjectTypeDef = {
  name: 'item',
  versions: [
    { version: 1, fields: { title: { type: 'string', maxLength: 10 }, done: { type: 'boolean' } } },
    {
      version: 2,
      fields: { name: { type: 'string', maxLength: 10 }, done: { type: 'boolean' }, priority: { type: 'integer', min: 0 } },
      up: migrate.all(migrate.rename('title', 'name'), migrate.addDefault('priority', 0)),
      down: migrate.mirrorRename('name', 'title'),
    },
    {
      version: 3,
      fields: { label: { type: 'string', maxLength: 10 }, done: { type: 'boolean' }, priority: { type: 'integer', min: 0 }, urgent: { type: 'boolean' } },
      up: migrate.all(migrate.rename('name', 'label'), migrate.convert('priority', 'urgent', (p) => (p as number) > 5)),
      breaking: true,
    },
  ],
};
const reg3 = new SchemaRegistry().register('m', def);
const reg2 = new SchemaRegistry().register('m', { ...def, versions: def.versions.slice(0, 2) });
const reg1 = new SchemaRegistry().register('m', { ...def, versions: def.versions.slice(0, 1) });

const obj = (fields: Record<string, unknown>, clocks: Record<string, string> = {}, schemaVersion = 1): SyncableObject => ({
  id: 'o1',
  type: 'm.item',
  space: 's1',
  schemaVersion,
  fields: fields as SyncableObject['fields'],
  clocks: { ...Object.fromEntries(Object.keys(fields).map((k) => [k, 'c1'])), ...clocks },
});

describe('one step', () => {
  it('a version 1 object is shown in version 2 names, with defaults', () => {
    const p = project(reg2, obj({ title: 'milk', done: true }));
    expect(p.fields).toEqual({ name: 'milk', done: true, priority: 0 });
    expect(p.seenVersion).toBe(1);
  });

  it('a version 2 peer reads fields written at version 2 as they are', () => {
    expect(project(reg2, obj({ name: 'oat', priority: 4 }, {}, 2)).fields).toEqual({ name: 'oat', priority: 4 });
  });

  it('when both the old and the new field were written, the later write wins', () => {
    expect(project(reg2, obj({ title: 'old', name: 'new' }, { title: 'c5', name: 'c3' })).fields.name).toBe('old');
    expect(project(reg2, obj({ title: 'old', name: 'new' }, { title: 'c3', name: 'c5' })).fields.name).toBe('new');
    expect(project(reg2, obj({ title: 'same', name: 'native' }, { title: 'c4', name: 'c4' })).fields.name).toBe('native'); // tie: native
  });

  it('removing the old field after the new one was set removes the new value', () => {
    const o = obj({ name: 'new' }, { name: 'c3', title: 'c9' });
    expect(project(reg2, o).fields).toEqual({ priority: 0 });
  });

  it('a real write to the default’s field beats the default; so does a later removal', () => {
    expect(project(reg2, obj({ priority: 3 })).fields.priority).toBe(3);
    expect(project(reg2, obj({}, { priority: 'c2' })).fields).toEqual({}); // removed: no default comes back
  });
});

describe('a chain of versions', () => {
  it('migrates 1 -> 2 -> 3, carrying the clock of the original write through derived values', () => {
    const p = project(reg3, obj({ title: 'milk', done: false }, { title: 'c5' }));
    expect(p.fields).toEqual({ label: 'milk', done: false, priority: 0, urgent: false });
    // the clock survived the first step: a native `label` written at c4 loses to a title written at c5, and wins over c3
    expect(project(reg3, obj({ title: 'T', label: 'L' }, { title: 'c5', label: 'c4' })).fields.label).toBe('T');
    expect(project(reg3, obj({ title: 'T', label: 'L' }, { title: 'c3', label: 'c4' })).fields.label).toBe('L');
  });

  it('a version 2 object (with its mirror) is shown in version 3 names', () => {
    expect(project(reg3, obj({ name: 'oat', title: 'oat', priority: 9 }, { name: 'c7', title: 'c7', priority: 'c7' }, 2)).fields).toEqual({ label: 'oat', priority: 9, urgent: true });
  });

  it('a step only decides its own version’s fields', () => {
    const odd: ObjectTypeDef = {
      name: 'item',
      versions: [
        { version: 1, fields: { a: { type: 'string' } } },
        { version: 2, fields: { b: { type: 'string' } }, up: () => ({ b: 'B', zzz: 'ignored' }), breaking: true },
      ],
    };
    const r = new SchemaRegistry().register('m', odd);
    expect(project(r, obj({ a: 'x' })).fields).toEqual({ b: 'B' });
  });

  it('a migration returning a plain value gets the newest clock of its input', () => {
    const plain: ObjectTypeDef = {
      name: 'item',
      versions: [
        { version: 1, fields: { a: { type: 'string' } } },
        { version: 2, fields: { b: { type: 'string' }, c: { type: 'string' } }, up: (prev) => ({ b: `${prev.get('a')}!` }), breaking: true },
        { version: 3, fields: { b: { type: 'string' }, c: { type: 'string' }, d: { type: 'string' } }, up: migrate.rename('c', 'd'), breaking: true },
      ],
    };
    const r = new SchemaRegistry().register('m', plain);
    expect(project(r, obj({ a: 'x' }, { a: 'c4' })).fields).toEqual({ b: 'x!' });
  });
});

describe('what stays out of the view', () => {
  it('names of older versions are kept in storage but not shown', () => {
    const p = project(reg3, obj({ title: 'milk', name: 'milk', legacy: 'x' }, {}, 2));
    expect(Object.keys(p.fields)).not.toContain('title');
    expect(Object.keys(p.fields)).not.toContain('legacy');
  });

  it('fields from a newer schema are not shown, and seenVersion reports the newer version', () => {
    const p = project(reg1, obj({ title: 'milk', done: true, future: [1, 2] }, {}, 4));
    expect(p.fields).toEqual({ title: 'milk', done: true });
    expect(p.seenVersion).toBe(4);
  });

  it('a stored value that fails the current schema is left out and listed', () => {
    const p = project(reg2, obj({ name: 'far too long a name', priority: -1 }, {}, 2));
    expect(p.fields).toEqual({});
    expect(p.violations).toEqual([
      { field: 'name', detail: expect.stringContaining('at most 10') },
      { field: 'priority', detail: expect.stringContaining('at least 0') },
    ]);
  });

  it('a value migrated from an older field is checked too', () => {
    const p = project(reg2, obj({ title: 'a title this long' }, {}, 1));
    expect(p.violations).toEqual([{ field: 'name', detail: expect.stringContaining('at most 10') }]);
  });

  it('works without clocks (all treated as equally old; native values win ties)', () => {
    const o: SyncableObject = { id: 'o1', type: 'm.item', space: 's1', schemaVersion: 2, fields: { title: 'old', name: 'new' } };
    expect(project(reg2, o).fields.name).toBe('new');
    expect(project(reg2, { ...o, fields: { title: 'only' } }).fields.name).toBe('only');
  });
});
