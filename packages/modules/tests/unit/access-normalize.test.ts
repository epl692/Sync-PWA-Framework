// T016: the effective access declaration.
import { describe, expect, it } from 'vitest';
import { normalizeAccess } from '../../src/definition/access';
import { validateDefinition } from '../../src/definition/rules';
import type { ModuleDefinition } from '../../src/types';

const type = (name: string) => ({ name, versions: [{ version: 1, fields: {} }] });
const def = (over: Partial<ModuleDefinition> = {}): ModuleDefinition => ({ id: 'todo', version: '1.0.0', ...over });

describe('normalizeAccess', () => {
  it('defaults: own types only, bound Spaces, no manage', () => {
    expect(normalizeAccess(def())).toEqual({ types: { read: [], write: [] }, spaces: { read: 'bound', write: 'bound', manage: false } });
  });
  it('own types are implicitly readable and writable and still reported', () => {
    const a = normalizeAccess(def({ provides: { types: [type('item'), type('tag')] } }));
    expect(a.types.read).toEqual(['todo.item', 'todo.tag']);
    expect(a.types.write).toEqual(['todo.item', 'todo.tag']);
  });
  it('write implies read, and lists are sorted and unique', () => {
    const a = normalizeAccess(def({ provides: { types: [type('item')] }, access: { types: { read: ['z.b', 'a.c', 'a.c'], write: ['m.w'] } } }));
    expect(a.types.read).toEqual(['a.c', 'm.w', 'todo.item', 'z.b']);
    expect(a.types.write).toEqual(['m.w', 'todo.item']);
  });
  it('keeps explicit spaces settings', () => {
    const a = normalizeAccess(def({ access: { spaces: { read: 'any', write: 'any', manage: true } } }));
    expect(a.spaces).toEqual({ read: 'any', write: 'any', manage: true });
  });
  it('does not mutate the definition', () => {
    const d = def({ access: { types: { read: ['a.b'] } } });
    const copy = JSON.stringify(d);
    normalizeAccess(d);
    expect(JSON.stringify(d)).toBe(copy);
  });
});

describe('spaces rules in validateDefinition', () => {
  it("write: 'any' requires read: 'any'", () => {
    const p = validateDefinition(def({ access: { spaces: { write: 'any' } } }));
    expect(p.join('\n')).toMatch(/write.*any.*read.*any/);
    expect(validateDefinition(def({ access: { spaces: { read: 'any', write: 'any' } } }))).toEqual([]);
    expect(validateDefinition(def({ access: { spaces: { read: 'any', write: 'bound' } } }))).toEqual([]);
  });
  it('rejects unknown scope values', () => {
    const p = validateDefinition(def({ access: { spaces: { read: 'all' as never } } }));
    expect(p.join('\n')).toContain('"all"');
  });
});
