// T047: validateBody follows contracts/schema-rules.md §1 exactly.
import { describe, expect, it } from 'vitest';
import type { JSONValue } from '@sync/core';
import { validateBody } from '../../src/schema/validate';
import { SchemaRegistry } from '../../src/schema/registry';
import type { FieldDef, ObjectTypeDef, RegisteredType } from '../../src/schema/types';

const reg = (def: ObjectTypeDef): RegisteredType => new SchemaRegistry().register('m', def);
const single = (fields: Record<string, FieldDef>, extra: Partial<ObjectTypeDef['versions'][0]> = {}) => reg({ name: 't', versions: [{ version: 1, fields, ...extra }] });
const body = (op: 'create' | 'update' | 'delete', fields: Record<string, JSONValue>, schemaVersion = 1) => ({ op, schemaVersion, fields });
const UNSET = { $unset: true };
const ok = (r: ReturnType<typeof validateBody>) => r.ok;
const detail = (r: ReturnType<typeof validateBody>) => (r.ok ? '' : r.detail);

describe('versions', () => {
  const two = reg({
    name: 't',
    versions: [
      { version: 1, fields: { title: { type: 'string', maxLength: 5 }, old: { type: 'string' } } },
      { version: 2, fields: { title: { type: 'string', maxLength: 10 }, name: { type: 'string', required: true } }, up: () => ({}), down: () => ({}) },
    ],
  });

  it.each([0, -1, 1.5, NaN, undefined as unknown as number])('rejects schemaVersion %s', (k) => {
    const r = validateBody(two, { op: 'update', schemaVersion: k, fields: {} });
    expect(r).toMatchObject({ ok: false });
    expect(detail(r)).toBe('bad-version');
  });

  it('validates against the packet’s own version', () => {
    expect(ok(validateBody(two, body('update', { title: 'abcdefgh' }, 1)))).toBe(false); // v1: max 5
    expect(ok(validateBody(two, body('update', { title: 'abcdefgh' }, 2)))).toBe(true); // v2: max 10
  });

  it('accepts names from earlier versions (down mirrors) but not names that were never declared', () => {
    expect(ok(validateBody(two, body('update', { name: 'x', old: 'mirror' }, 2)))).toBe(true);
    const r = validateBody(two, body('update', { nope: 1 }, 2));
    expect(r).toMatchObject({ ok: false, field: 'nope', detail: 'unknown-field' });
    expect(ok(validateBody(two, body('update', { name: 'x' }, 1)))).toBe(false); // `name` does not exist in v1
  });

  it('uses the constraints of the newest version at or below k that declares the name', () => {
    expect(ok(validateBody(two, body('update', { old: 'anything' }, 2)))).toBe(true);
    expect(ok(validateBody(two, body('update', { title: 'abcdefgh' }, 2)))).toBe(true);
  });
});

describe('newer than known (lenient)', () => {
  const r = reg({
    name: 't',
    versions: [{ version: 1, fields: { title: { type: 'string', required: true, maxLength: 3, check: (v) => (v === 'bad' ? 'no' : undefined) }, n: { type: 'integer' }, e: { type: 'enum', values: ['a', 'b'] } } }],
  });
  it('passes unknown field names through untouched', () => {
    expect(ok(validateBody(r, body('update', { future: { anything: [1, 2] } }, 5)))).toBe(true);
  });
  it('still type-checks the names it knows', () => {
    expect(ok(validateBody(r, body('update', { n: 'x' }, 5)))).toBe(false);
    expect(ok(validateBody(r, body('update', { title: 7 }, 5)))).toBe(false);
  });
  it('does not apply constraints, custom checks, enum membership or required', () => {
    expect(ok(validateBody(r, body('update', { title: 'toolong', e: 'zzz' }, 5)))).toBe(true);
    expect(ok(validateBody(r, body('update', { title: 'bad' }, 5)))).toBe(true);
    expect(ok(validateBody(r, body('create', { n: 1 }, 5)))).toBe(true); // title missing
    expect(ok(validateBody(r, body('update', { title: UNSET }, 5)))).toBe(true);
  });
  it('an enum still has to be a string', () => {
    expect(ok(validateBody(r, body('update', { e: 5 }, 5)))).toBe(false);
  });
});

describe('create and update', () => {
  const r = single({ title: { type: 'string', required: true }, note: { type: 'string' } }, {
    objectCheck: (f) => (f.note === 'x' && f.title === 'x' ? 'title and note must differ' : undefined),
  });
  it('create requires required fields to be present and not unset', () => {
    expect(ok(validateBody(r, body('create', { title: 'a' })))).toBe(true);
    expect(detail(validateBody(r, body('create', { note: 'a' })))).toMatch(/title.*required/);
    expect(ok(validateBody(r, body('create', { title: UNSET })))).toBe(false);
  });
  it('create runs objectCheck over the full field set', () => {
    expect(detail(validateBody(r, body('create', { title: 'x', note: 'x' })))).toBe('title and note must differ');
  });
  it('a throwing objectCheck rejects instead of crashing', () => {
    const t = single({ a: { type: 'string' } }, { objectCheck: () => { throw new Error('oops'); } });
    expect(detail(validateBody(t, body('create', { a: 'x' })))).toMatch(/check-threw.*oops/);
  });
  it('update does not require required fields, but cannot unset one', () => {
    expect(ok(validateBody(r, body('update', { note: 'a' })))).toBe(true);
    expect(ok(validateBody(r, body('update', { title: UNSET })))).toBe(false);
    expect(ok(validateBody(r, body('update', { note: UNSET })))).toBe(true);
  });
  it('delete is always accepted', () => {
    expect(ok(validateBody(r, body('delete', {})))).toBe(true);
  });
});

describe('field types and constraints', () => {
  const cases: Array<[string, FieldDef, JSONValue[], JSONValue[]]> = [
    ['string', { type: 'string', maxLength: 3, pattern: '^[a-z]+$' }, ['abc', 'a'], [1, null, 'abcd', 'AB', true]],
    ['number', { type: 'number', min: 0, max: 10 }, [0, 5.5, 10], [-1, 11, '1', null, true]],
    ['integer', { type: 'integer', min: 0 }, [0, 7], [1.5, -1, '1', null]],
    ['boolean', { type: 'boolean' }, [true, false], [0, 'true', null]],
    ['timestamp', { type: 'timestamp', min: 100 }, [100, 1_700_000_000_000], [99, -5, 1.5, '1']],
    ['enum', { type: 'enum', values: ['a', 'b'] }, ['a', 'b'], ['c', 1, null]],
    ['ref', { type: 'ref' }, ['abc'], ['', 1, null]],
    ['json', { type: 'json', maxBytes: 12 }, [{ a: 1 }, [1, 2], 'x', null], [{ a: 'a long string value' }]],
    ['list', { type: 'list', of: 'string', maxItems: 2 }, [[], ['a', 'b']], [['a', 'b', 'c'], [1], 'a', null]],
    ['list of numbers', { type: 'list', of: 'number' }, [[1, 2.5]], [['1'], [null]]],
  ];
  it.each(cases)('%s', (_n, def, good, bad) => {
    const t = single({ f: def });
    for (const v of good) expect(ok(validateBody(t, body('update', { f: v }))), JSON.stringify(v)).toBe(true);
    for (const v of bad) expect(ok(validateBody(t, body('update', { f: v }))), JSON.stringify(v)).toBe(false);
  });

  it('json defaults to 64 KiB and list to 256 items', () => {
    const t = single({ j: { type: 'json' }, l: { type: 'list', of: 'number' } });
    expect(ok(validateBody(t, body('update', { j: 'x'.repeat(60_000) })))).toBe(true);
    expect(ok(validateBody(t, body('update', { j: 'x'.repeat(70_000) })))).toBe(false);
    expect(ok(validateBody(t, body('update', { l: Array(256).fill(1) })))).toBe(true);
    expect(ok(validateBody(t, body('update', { l: Array(257).fill(1) })))).toBe(false);
  });

  it('a custom check rejects with its message; a throwing check rejects with check-threw', () => {
    const t = single({ a: { type: 'string', check: (v) => (v === 'no' ? 'not allowed' : undefined) }, b: { type: 'string', check: () => { throw new Error('boom'); } } });
    expect(validateBody(t, body('update', { a: 'no' }))).toMatchObject({ ok: false, field: 'a', detail: expect.stringContaining('not allowed') });
    expect(ok(validateBody(t, body('update', { a: 'yes' })))).toBe(true);
    expect(validateBody(t, body('update', { b: 'x' }))).toMatchObject({ ok: false, field: 'b', detail: expect.stringContaining('check-threw: boom') });
  });

  it('names the failing field', () => {
    const t = single({ a: { type: 'integer' } });
    expect(validateBody(t, body('update', { a: 'x' }))).toMatchObject({ ok: false, field: 'a' });
  });
});
