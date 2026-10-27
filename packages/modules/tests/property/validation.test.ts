// T048 (SC-003): validateBody agrees with an independently written oracle on every generated body.
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import type { JSONValue } from '@sync/core';
import { validateBody } from '../../src/schema/validate';
import { SchemaRegistry } from '../../src/schema/registry';
import type { FieldDef, ObjectTypeDef } from '../../src/schema/types';

const RUNS = Number(process.env.VALIDATION_RUNS ?? 10_000);

// ---- a small pool of fields; each name has one type in every version ----
const POOL: Record<string, (version: number) => FieldDef> = {
  s1: (v) => ({ type: 'string', maxLength: 5 + 3 * (v - 1) }),
  s2: () => ({ type: 'string', pattern: '^[a-z]+$' }),
  n1: () => ({ type: 'number', min: 0, max: 10 }),
  i1: () => ({ type: 'integer' }),
  b1: () => ({ type: 'boolean' }),
  t1: () => ({ type: 'timestamp' }),
  e1: () => ({ type: 'enum', values: ['a', 'b'] }),
  r1: () => ({ type: 'ref' }),
  j1: () => ({ type: 'json', maxBytes: 20 }),
  l1: () => ({ type: 'list', of: 'string', maxItems: 3 }),
  c1: () => ({ type: 'string', check: (v) => (v === 'bad' ? 'bad' : undefined) }),
  req: () => ({ type: 'string', required: true }),
};
const NAMES = Object.keys(POOL);

const SAMPLES: Record<string, JSONValue[]> = {
  s1: ['', 'abc', 'abcde', 'abcdef', 'abcdefgh', 'abcdefghi', 7, null],
  s2: ['abc', 'ABC', 'a1', '', 5],
  n1: [0, 3.5, 10, 11, -1, '3', null],
  i1: [0, 5, 1.5, '1', null],
  b1: [true, false, 'true', 0],
  t1: [0, 1_700_000_000_000, -1, 1.5, 'x'],
  e1: ['a', 'b', 'c', 1],
  r1: ['id1', '', 5],
  j1: [{ a: 1 }, 'x', { a: 'this is more than twenty bytes' }, null],
  l1: [[], ['a'], ['a', 'b', 'c'], ['a', 'b', 'c', 'd'], [1], 'a'],
  c1: ['ok', 'bad', 3],
  req: ['x', 1, null],
};
const UNSET = { $unset: true };

interface Case {
  versions: string[][]; // field names per version
  body: { op: 'create' | 'update' | 'delete'; schemaVersion: number; fields: Record<string, JSONValue> };
}

const caseArb: fc.Arbitrary<Case> = fc
  .record({
    versions: fc.array(fc.uniqueArray(fc.constantFrom(...NAMES), { minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 3 }),
    op: fc.constantFrom('create', 'update', 'delete') as fc.Arbitrary<'create' | 'update' | 'delete'>,
    k: fc.integer({ min: -1, max: 5 }),
    picks: fc.array(
      fc.record({
        name: fc.oneof(fc.constantFrom(...NAMES), fc.constantFrom('zz', 'unknown')),
        sample: fc.nat({ max: 20 }),
        unset: fc.boolean(),
      }),
      { maxLength: 6 },
    ),
  })
  .map(({ versions, op, k, picks }) => {
    const fields: Record<string, JSONValue> = {};
    for (const p of picks) {
      const pool = SAMPLES[p.name];
      fields[p.name] = p.unset && p.sample % 4 === 0 ? UNSET : pool ? pool[p.sample % pool.length]! : p.sample;
    }
    return { versions, body: { op, schemaVersion: k, fields } };
  });

function buildDef(versions: string[][]): ObjectTypeDef {
  return {
    name: 't',
    versions: versions.map((names, i) => {
      const v = i + 1;
      return { version: v, fields: Object.fromEntries(names.map((n) => [n, POOL[n]!(v)])), ...(v > 1 ? { up: () => ({}), breaking: true } : {}) };
    }),
  };
}

// ---- the oracle: written from the rules table, not from the implementation ----
function valueOk(name: string, version: number, v: JSONValue, lenient: boolean): boolean {
  const base = (() => {
    switch (name) {
      case 's1': case 's2': case 'c1': case 'r1': return typeof v === 'string' && (name !== 'r1' || v.length > 0);
      case 'n1': return typeof v === 'number' && Number.isFinite(v);
      case 'i1': return Number.isSafeInteger(v);
      case 'b1': return typeof v === 'boolean';
      case 't1': return Number.isSafeInteger(v) && (v as number) >= 0;
      case 'e1': return typeof v === 'string';
      case 'j1': return true;
      case 'l1': return Array.isArray(v) && v.every((x) => typeof x === 'string');
      case 'req': return typeof v === 'string';
      default: return false;
    }
  })();
  if (!base || lenient) return base;
  const s = v as never as string & number & unknown[];
  switch (name) {
    case 's1': return (v as string).length <= 5 + 3 * (version - 1);
    case 's2': return /^[a-z]+$/.test(v as string);
    case 'n1': return (v as number) >= 0 && (v as number) <= 10;
    case 'e1': return v === 'a' || v === 'b';
    case 'j1': return new TextEncoder().encode(JSON.stringify(v)).length <= 20;
    case 'l1': return (s as unknown[]).length <= 3;
    case 'c1': return v !== 'bad';
    default: return true;
  }
}

function oracle(versions: string[][], b: Case['body']): boolean {
  if (b.op === 'delete') return true;
  const L = versions.length;
  const k = b.schemaVersion;
  if (!Number.isInteger(k) || k < 1) return false;
  const lenient = k > L;
  const top = Math.min(k, L);
  const known = (n: string) => versions.slice(0, top).some((names) => names.includes(n));
  const newestDeclaring = (n: string) => {
    for (let v = top; v >= 1; v--) if (versions[v - 1]!.includes(n)) return v;
    return 0;
  };
  for (const [n, v] of Object.entries(b.fields)) {
    if (!known(n)) {
      if (lenient) continue;
      return false;
    }
    const unset = typeof v === 'object' && v !== null && !Array.isArray(v) && (v as { $unset?: boolean }).$unset === true;
    const ownRequired = n === 'req' && versions[top - 1]!.includes('req');
    if (unset) {
      if (!lenient && ownRequired) return false;
      continue;
    }
    if (!valueOk(n, newestDeclaring(n), v, lenient)) return false;
  }
  if (b.op === 'create' && !lenient && versions[top - 1]!.includes('req')) {
    const v = b.fields.req;
    const unset = typeof v === 'object' && v !== null && !Array.isArray(v) && (v as { $unset?: boolean }).$unset === true;
    if (v === undefined || unset) return false;
  }
  return true;
}

describe('validateBody vs oracle (SC-003)', () => {
  it(`agrees on ${RUNS} generated schemas and bodies, and is pure`, () => {
    fc.assert(
      fc.property(caseArb, (c) => {
        const reg = new SchemaRegistry().register('m', buildDef(c.versions));
        const first = validateBody(reg, c.body);
        const second = validateBody(reg, c.body);
        expect(second.ok).toBe(first.ok); // same input, same verdict
        const shuffled = { ...c.body, fields: Object.fromEntries(Object.entries(c.body.fields).reverse()) };
        expect(validateBody(reg, shuffled).ok).toBe(first.ok); // not order dependent
        expect(first.ok).toBe(oracle(c.versions, c.body));
      }),
      { numRuns: RUNS },
    );
  });

  it('refuses every schema-violating body in a violation-only run (100%)', () => {
    let violating = 0;
    fc.assert(
      fc.property(caseArb, (c) => {
        const reg = new SchemaRegistry().register('m', buildDef(c.versions));
        if (oracle(c.versions, c.body)) return;
        violating++;
        expect(validateBody(reg, c.body).ok).toBe(false);
      }),
      { numRuns: RUNS },
    );
    expect(violating).toBeGreaterThan(RUNS / 10); // the generator really produces violations
  });
});
