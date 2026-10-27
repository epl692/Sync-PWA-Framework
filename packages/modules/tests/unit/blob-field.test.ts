// T035 (M-1, spec 004): the `blob` field type validates attachment references like any other field.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { JSONValue } from '@sync/core';
import { checkSchema } from '../../src/schema/lint';
import { project } from '../../src/schema/project';
import { SchemaRegistry } from '../../src/schema/registry';
import { checkBaseType, validateFieldValue } from '../../src/schema/fields';
import type { FieldDef, ObjectTypeDef } from '../../src/schema/types';

const ID = 'A'.repeat(43);
const ref = (over: Record<string, unknown> = {}): JSONValue =>
  ({ $blob: 1, id: ID, size: 1000, type: 'image/png', space: 'S', scope: 'S', keyId: '0123456789abcdef', name: 'a.png', ...over }) as JSONValue;
const def = (field: FieldDef, extra: Partial<ObjectTypeDef> = {}): ObjectTypeDef => ({ name: 'item', versions: [{ version: 1, fields: { photo: field } }], ...extra });

describe('checkSchema', () => {
  it('accepts blob fields with options and a list of blobs', () => {
    expect(checkSchema(def({ type: 'blob', required: true, accept: ['image/*', 'application/pdf'], maxBytes: 5_000_000 }))).toEqual([]);
    expect(checkSchema(def({ type: 'list', of: 'blob', maxItems: 10, accept: ['image/*'] }))).toEqual([]);
    expect(checkSchema(def({ type: 'blob' }))).toEqual([]);
  });

  it.each([
    ['an accept entry that is not a media type', { type: 'blob', accept: ['jpeg'] }],
    ['an empty accept list', { type: 'blob', accept: [] }],
    ['maxBytes zero', { type: 'blob', maxBytes: 0 }],
    ['maxBytes above 16 GiB', { type: 'blob', maxBytes: 17 * 1024 ** 3 }],
    ['maxBytes that is not an integer', { type: 'blob', maxBytes: 1.5 }],
  ] as Array<[string, FieldDef]>)('rejects %s', (_n, f) => {
    expect(checkSchema(def(f)).length).toBeGreaterThan(0);
  });
});

describe('validateFieldValue', () => {
  const f: FieldDef = { type: 'blob', accept: ['image/*', 'application/pdf'], maxBytes: 2000 };

  it('accepts a good reference, with and without a name', () => {
    expect(validateFieldValue(f, ref())).toBeUndefined();
    expect(validateFieldValue(f, ref({ name: undefined }))).toBeUndefined();
  });

  it('applies accept patterns (wildcard subtype and exact type) and maxBytes', () => {
    expect(validateFieldValue(f, ref({ type: 'application/pdf' }))).toBeUndefined();
    expect(validateFieldValue(f, ref({ type: 'text/plain' }))).toMatch(/accepted/);
    expect(validateFieldValue(f, ref({ size: 2001 }))).toMatch(/2000/);
    expect(validateFieldValue({ type: 'blob' }, ref({ type: 'anything/goes' }))).toBeUndefined();
  });

  it('rejects junk with a readable reason', () => {
    for (const v of ['x', 5, null, [], {}, { $blob: 1 }, ref({ id: 'short' }), ref({ size: 0 }), ref({ keyId: 'zz' })]) {
      const r = validateFieldValue(f, v as JSONValue);
      expect(typeof r).toBe('string');
      expect(r!.length).toBeGreaterThan(3);
    }
  });

  it('keeps a reference of a future version (valid, opaque) so older peers still store and relay it', () => {
    expect(validateFieldValue(f, { $blob: 2, whatever: true } as JSONValue)).toBeUndefined();
  });

  it('validates every item of a list of blobs and the item limit', () => {
    const l: FieldDef = { type: 'list', of: 'blob', maxItems: 2, accept: ['image/*'] };
    expect(validateFieldValue(l, [ref(), ref({ type: 'image/jpeg' })])).toBeUndefined();
    expect(validateFieldValue(l, [ref(), ref(), ref()])).toMatch(/at most 2/);
    expect(validateFieldValue(l, [ref(), 'x'])).toMatch(/blob/);
    expect(validateFieldValue(l, [ref({ type: 'text/plain' })])).toMatch(/accepted/);
  });

  it('checks only the JSON shape for packets of a newer schema (checkBaseType)', () => {
    expect(checkBaseType({ type: 'blob', maxBytes: 1 }, ref({ size: 99999 }))).toBeUndefined();
    expect(checkBaseType({ type: 'blob' }, 'x' as JSONValue)).toMatch(/blob/);
    expect(checkBaseType({ type: 'list', of: 'blob' }, [ref()])).toBeUndefined();
    expect(checkBaseType({ type: 'list', of: 'blob' }, [3] as JSONValue[])).toMatch(/blob/);
  });
});

/** An independent, deliberately naive statement of the rules in data-model.md, to compare the real validator against. */
function oracle(f: Extract<FieldDef, { type: 'blob' }>, v: unknown): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (o.$blob === undefined) return false;
  if (o.$blob !== 1) return true;
  if (typeof o.id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(o.id) || 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(o.id[42]!) % 4 !== 0) return false;
  if (typeof o.size !== 'number' || !Number.isInteger(o.size) || o.size <= 0) return false;
  if (o.size > Math.min(f.maxBytes ?? 1024 ** 3, 16 * 1024 ** 3)) return false;
  if (typeof o.type !== 'string' || o.type.length > 127 || !/^[\w.+-]+\/[\w.+-]+$/.test(o.type)) return false;
  if (typeof o.space !== 'string' || !o.space || o.space.length > 128) return false;
  if (typeof o.scope !== 'string' || !o.scope || o.scope.length > 128) return false;
  if (typeof o.keyId !== 'string' || !/^[0-9a-f]{16}$/.test(o.keyId)) return false;
  if (o.name !== undefined && (typeof o.name !== 'string' || o.name.length > 255)) return false;
  if (f.accept) {
    const t = o.type.toLowerCase();
    if (!f.accept.some((p) => (p.endsWith('/*') ? t.startsWith(p.slice(0, -1).toLowerCase()) : t === p.toLowerCase()))) return false;
  }
  return true;
}

describe('oracle comparison (property)', () => {
  const field: Extract<FieldDef, { type: 'blob' }> = { type: 'blob', accept: ['image/*', 'application/pdf'], maxBytes: 1_000_000 };
  const arbRef = fc.record(
    {
      $blob: fc.constantFrom(1, 1, 1, 2, undefined),
      id: fc.oneof(fc.constant(ID), fc.string({ minLength: 43, maxLength: 43 }), fc.string({ maxLength: 5 }), fc.integer()),
      size: fc.oneof(fc.integer({ min: -5, max: 2_000_000 }), fc.double(), fc.string()),
      type: fc.oneof(fc.constantFrom('image/png', 'application/pdf', 'text/plain', 'IMAGE/JPEG', 'jpeg', 'a/b c'), fc.string({ maxLength: 20 })),
      space: fc.oneof(fc.constant('S'), fc.constant(''), fc.integer()),
      scope: fc.oneof(fc.constant('S'), fc.constant(''), fc.integer()),
      keyId: fc.oneof(fc.constant('0123456789abcdef'), fc.string({ maxLength: 20 })),
      name: fc.oneof(fc.constant(undefined), fc.string({ maxLength: 300 })),
    },
    { requiredKeys: [] },
  );
  it('agrees with the oracle on thousands of generated values', () => {
    fc.assert(
      fc.property(fc.oneof(arbRef, fc.jsonValue()), (v) => {
        const mine = validateFieldValue(field, v as JSONValue) === undefined;
        expect(mine).toBe(oracle(field, v));
      }),
      { numRuns: 3000 },
    );
  });
});

describe('projection and migration', () => {
  it('treat the reference as an opaque value, across versions', () => {
    const reg = new SchemaRegistry();
    const rt = reg.register('m', {
      name: 'item',
      versions: [
        { version: 1, fields: { photo: { type: 'blob' } } },
        { version: 2, fields: { photo: { type: 'blob' }, caption: { type: 'string' } }, up: () => ({}), down: () => ({}) },
      ],
    });
    const photo = ref();
    const out = project(rt, { id: 'o1', type: 'm.item', space: 'S', schemaVersion: 1, fields: { photo } });
    expect(out.fields.photo).toEqual(photo);
  });

  it('a schema without blob fields is unaffected', () => {
    expect(checkSchema({ name: 'plain', versions: [{ version: 1, fields: { title: { type: 'string' } } }] })).toEqual([]);
  });
});
