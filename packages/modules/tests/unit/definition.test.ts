// T015: definition rules. Each problem names the module and the offending value.
import { describe, expect, it } from 'vitest';
import { defineModule } from '../../src/definition/define';
import { validateDefinition } from '../../src/definition/rules';
import type { ModuleDefinition } from '../../src/types';

const ok = (over: Partial<ModuleDefinition> = {}): ModuleDefinition => ({ id: 'todo', version: '1.0.0', ...over });
const noop = () => class extends (globalThis.HTMLElement ?? (class {} as any)) {};

describe('defineModule', () => {
  it('is an identity function', () => {
    const d = ok();
    expect(defineModule(d)).toBe(d);
  });
});

describe('module id', () => {
  it.each(['todo', 'ab', 'a1', 'a'.repeat(24)])('accepts %j', (id) => {
    expect(validateDefinition(ok({ id }))).toEqual([]);
  });
  it.each(['a', 'A', '1a', 'to-do', 'to_do', 'a'.repeat(25), '', 'to do'])('rejects %j', (id) => {
    const p = validateDefinition(ok({ id }));
    expect(p.length).toBeGreaterThan(0);
    expect(p.join('\n')).toContain(JSON.stringify(id));
  });
});

describe('version', () => {
  it('must be semver x.y.z and the error names the module and value', () => {
    const p = validateDefinition(ok({ version: '1.0' }));
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('"todo"');
    expect(p[0]).toContain('"1.0"');
  });
});

describe('dependencies', () => {
  it('accepts valid ranges', () => {
    expect(validateDefinition(ok({ dependencies: { other: '^1.0.0', more: '~2.1.0', exact: '3.0.0', gte: '>=1.0.0' } }))).toEqual([]);
  });
  it('rejects an invalid range, an invalid dependency id and a self-dependency', () => {
    const p = validateDefinition(ok({ dependencies: { other: '*', 'Bad Id': '1.0.0', todo: '1.0.0' } }));
    expect(p.some((x) => x.includes('"*"'))).toBe(true);
    expect(p.some((x) => x.includes('"Bad Id"'))).toBe(true);
    expect(p.some((x) => /cannot depend on itself/.test(x))).toBe(true);
  });
});

describe('registrations are namespaced by the module id', () => {
  const type = (name: string) => ({ name, versions: [{ version: 1, fields: {} }] });
  it('type local names must match ^[a-z][A-Za-z0-9_]{0,31}$ (so the type is <id>.<name>)', () => {
    expect(validateDefinition(ok({ provides: { types: [type('item'), type('lineItem2')] } }))).toEqual([]);
    for (const bad of ['Item', '1item', 'it-em', '$sys', 'todo.item', 'a'.repeat(33), '']) {
      const p = validateDefinition(ok({ provides: { types: [type(bad)] } }));
      expect(p.length, bad).toBeGreaterThan(0);
      expect(p.join('\n')).toContain(JSON.stringify(bad));
    }
  });
  it('rejects duplicate type names inside one module', () => {
    const p = validateDefinition(ok({ provides: { types: [type('item'), type('item')] } }));
    expect(p.join('\n')).toMatch(/duplicate type "todo.item"/);
  });
  it('view names make valid custom element names <id>-<name>', () => {
    expect(validateDefinition(ok({ provides: { views: { list: noop, 'edit-row': noop } } }))).toEqual([]);
    for (const bad of ['List', 'a b', '-x', 'x-', '1x', '']) {
      const p = validateDefinition(ok({ provides: { views: { [bad]: noop } } }));
      expect(p.length, bad).toBeGreaterThan(0);
    }
  });
  it('feature, transport and provider ids are well-formed and unique per kind', () => {
    const start = () => undefined;
    expect(validateDefinition(ok({ provides: { features: [{ id: 'sync', start }], transports: [{ id: 'ws', create: (() => ({})) as any }], identityProviders: [{ id: 'p', create: (() => ({})) as any }] } }))).toEqual([]);
    const p = validateDefinition(ok({ provides: { features: [{ id: 'a', start }, { id: 'a', start }, { id: 'Bad', start }] } }));
    expect(p.join('\n')).toMatch(/duplicate feature "todo.a"/);
    expect(p.join('\n')).toContain('"Bad"');
  });
});

describe('access type names', () => {
  it('must be full names module.name', () => {
    expect(validateDefinition(ok({ access: { types: { read: ['other.thing'], write: ['more.stuff'] } } }))).toEqual([]);
    const p = validateDefinition(ok({ access: { types: { read: ['thing'], write: ['$sys.x'] } } }));
    expect(p.join('\n')).toContain('"thing"');
    expect(p.join('\n')).toContain('"$sys.x"');
  });
});
