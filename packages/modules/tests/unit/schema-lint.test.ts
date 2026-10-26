// T017: checkSchema (schema-rules.md §2) and the registry. The `down` output-name check is T097/T104.
import { describe, expect, it } from 'vitest';
import { checkSchema } from '../../src/schema/lint';
import { SchemaRegistry } from '../../src/schema/registry';
import type { ObjectTypeDef, SchemaVersion } from '../../src/schema/types';

const v1: SchemaVersion = { version: 1, fields: { title: { type: 'string', required: true } } };
const up = () => ({});
const v2: SchemaVersion = { version: 2, fields: { name: { type: 'string' } }, up, down: () => ({}) };
const def = (over: Partial<ObjectTypeDef> = {}): ObjectTypeDef => ({ name: 'item', versions: [v1], ...over });

describe('checkSchema: versions', () => {
  it('accepts a valid single version and a valid chain', () => {
    expect(checkSchema(def())).toEqual([]);
    expect(checkSchema(def({ versions: [v1, v2] }))).toEqual([]);
  });
  it('requires a non-empty list', () => {
    expect(checkSchema(def({ versions: [] })).join()).toMatch(/at least one version/);
  });
  it('requires ascending, contiguous versions starting at 1', () => {
    expect(checkSchema(def({ versions: [{ ...v1, version: 2 }] })).join()).toMatch(/contiguous/);
    expect(checkSchema(def({ versions: [v1, { ...v2, version: 3 }] })).join()).toMatch(/contiguous/);
    expect(checkSchema(def({ versions: [v2, v1] })).join()).toMatch(/contiguous/);
  });
  it('requires `up` for version > 1', () => {
    expect(checkSchema(def({ versions: [v1, { ...v2, up: undefined }] })).join()).toMatch(/version 2.*up/);
  });
  it('requires `down` or `breaking: true` for version > 1', () => {
    const p = checkSchema(def({ versions: [v1, { ...v2, down: undefined }] }));
    expect(p.join()).toMatch(/version 2.*down.*breaking/);
    expect(checkSchema(def({ versions: [v1, { ...v2, down: undefined, breaking: true }] }))).toEqual([]);
  });
  it('keeps one type per field name across versions', () => {
    const bad = { ...v2, fields: { title: { type: 'number' as const } } };
    expect(checkSchema(def({ versions: [v1, bad] })).join()).toMatch(/field "title".*string.*number/);
  });
  it('checks compatWrite is within [1, latest]', () => {
    expect(checkSchema(def({ versions: [v1, v2], compatWrite: 1 }))).toEqual([]);
    expect(checkSchema(def({ versions: [v1, v2], compatWrite: 0 })).join()).toMatch(/compatWrite/);
    expect(checkSchema(def({ versions: [v1, v2], compatWrite: 3 })).join()).toMatch(/compatWrite/);
  });
});

describe('checkSchema: fields', () => {
  const one = (fields: SchemaVersion['fields']) => checkSchema(def({ versions: [{ version: 1, fields }] }));
  it('names match ^[a-z][A-Za-z0-9_]{0,31}$ and never start with $', () => {
    expect(one({ ok_1: { type: 'string' }, camelCase: { type: 'string' } })).toEqual([]);
    for (const bad of ['Title', '1a', '$x', 'a-b', 'a'.repeat(33), '']) expect(one({ [bad]: { type: 'string' } }).join(), bad).toContain(JSON.stringify(bad));
  });
  it('type name must match the same pattern', () => {
    expect(checkSchema(def({ name: 'Bad' })).join()).toContain('"Bad"');
  });
  it('enum needs at least one value and no duplicates', () => {
    expect(one({ s: { type: 'enum', values: [] } }).join()).toMatch(/at least one value/);
    expect(one({ s: { type: 'enum', values: ['a', 'a'] } }).join()).toMatch(/duplicate/);
    expect(one({ s: { type: 'enum', values: ['a', 'b'], default: 'a' } })).toEqual([]);
  });
  it('pattern must compile', () => {
    expect(one({ s: { type: 'string', pattern: '(' } }).join()).toMatch(/pattern/);
    expect(one({ s: { type: 'string', pattern: '^a+$' } })).toEqual([]);
  });
  it('a default must satisfy its own field', () => {
    expect(one({ n: { type: 'integer', default: 1.5 } }).join()).toMatch(/default/);
    expect(one({ s: { type: 'string', maxLength: 2, default: 'abc' } }).join()).toMatch(/default/);
    expect(one({ e: { type: 'enum', values: ['a'], default: 'z' } }).join()).toMatch(/default/);
    expect(one({ s: { type: 'string', required: true, default: 'x' } })).toEqual([]);
  });
  it('constraints must be consistent (min <= max)', () => {
    expect(one({ n: { type: 'number', min: 5, max: 1 } }).join()).toMatch(/min.*max/);
  });
});

describe('SchemaRegistry', () => {
  it('registers as <module>.<name>, lists, gets and unregisters', () => {
    const r = new SchemaRegistry();
    const t = r.register('todo', def({ versions: [v1, v2] }));
    expect(t).toMatchObject({ type: 'todo.item', module: 'todo', latest: 2 });
    expect(r.get('todo.item')).toBe(t);
    expect(r.list()).toHaveLength(1);
    r.unregister('todo.item');
    expect(r.get('todo.item')).toBeUndefined();
  });
  it('throws on a lint problem, listing every problem', () => {
    const r = new SchemaRegistry();
    expect(() => r.register('todo', def({ name: 'Bad', versions: [] }))).toThrow(/Bad[\s\S]*at least one version/);
    expect(r.list()).toHaveLength(0);
  });
  it('throws on a duplicate type naming both modules', () => {
    const r = new SchemaRegistry();
    r.register('todo', def());
    expect(() => r.register('todo', def())).toThrow(/todo\.item.*already registered.*todo.*todo/);
  });
});
