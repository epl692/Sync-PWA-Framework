// T026: resolving module definitions into an activation order (research R-05, R-06).
import { describe, expect, it } from 'vitest';
import { resolveModules, type ResolveEntry } from '../../src/host/resolve';
import { mod } from '../helpers';

const e = (def: ReturnType<typeof mod>, source: 'bundled' | 'runtime' = 'bundled'): ResolveEntry => ({ def, source });
const status = (r: ReturnType<typeof resolveModules>, id: string) => r.results.find((x) => x.entry.def.id === id)!;

describe('order', () => {
  it('puts dependencies first, and breaks ties by id', () => {
    const r = resolveModules([
      e(mod('zed')),
      e(mod('aa', { dependencies: { bb: '^1.0.0' } })),
      e(mod('bb', { dependencies: { cc: '1.0.0' } })),
      e(mod('cc')),
      e(mod('alpha')),
    ]);
    expect(r.order.map((x) => x.def.id)).toEqual(['alpha', 'cc', 'bb', 'aa', 'zed']);
    expect(r.results.every((x) => x.status === 'resolved')).toBe(true);
  });
  it('is the same whatever order the entries are listed in', () => {
    const defs = [mod('x', { dependencies: { y: '^1.0.0' } }), mod('y'), mod('w')];
    const a = resolveModules(defs.map((d) => e(d))).order.map((x) => x.def.id);
    const b = resolveModules([...defs].reverse().map((d) => e(d))).order.map((x) => x.def.id);
    expect(a).toEqual(b);
  });
});

describe('failures stay local', () => {
  it('a missing dependency skips the dependent and its dependents only', () => {
    const r = resolveModules([e(mod('aa', { dependencies: { ghost: '^1.0.0' } })), e(mod('bb', { dependencies: { aa: '^1.0.0' } })), e(mod('cc'))]);
    expect(status(r, 'aa')).toMatchObject({ status: 'skipped' });
    expect(status(r, 'aa').reason).toMatch(/missing dependency "ghost"/);
    expect(status(r, 'bb')).toMatchObject({ status: 'skipped' });
    expect(status(r, 'cc').status).toBe('resolved');
    expect(r.order.map((x) => x.def.id)).toEqual(['cc']);
  });
  it('an invalid definition fails that module and skips its dependents', () => {
    const r = resolveModules([e(mod('Bad Id')), e(mod('ok')), e({ id: 'dep', version: '1.0.0', dependencies: { 'Bad Id': '1.0.0' } })]);
    expect(status(r, 'Bad Id').status).toBe('failed');
    expect(status(r, 'Bad Id').reason).toMatch(/id "Bad Id"/);
    expect(status(r, 'ok').status).toBe('resolved');
    expect(status(r, 'dep').status).toBe('failed'); // its own dependency id is invalid
  });
  it('a dependency that failed skips the dependent', () => {
    const r = resolveModules([e(mod('base', { version: 'oops' })), e(mod('top', { dependencies: { base: '^1.0.0' } }))]);
    expect(status(r, 'base').status).toBe('failed');
    expect(status(r, 'top').status).toBe('skipped');
    expect(status(r, 'top').reason).toMatch(/dependency "base"/);
  });
  it('an unsatisfied range fails the dependent only', () => {
    const r = resolveModules([
      e(mod('shared', { version: '2.0.0' })),
      e(mod('wants1', { dependencies: { shared: '^1.0.0' } })),
      e(mod('wants2', { dependencies: { shared: '^2.0.0' } })),
    ]);
    expect(status(r, 'shared').status).toBe('resolved');
    expect(status(r, 'wants1').status).toBe('failed');
    expect(status(r, 'wants1').reason).toMatch(/unsatisfied-dependency.*"shared".*\^1\.0\.0.*2\.0\.0/);
    expect(status(r, 'wants2').status).toBe('resolved');
  });
  it('a cycle fails only its members; modules that merely depend on it are skipped', () => {
    const r = resolveModules([
      e(mod('aa', { dependencies: { bb: '^1.0.0' } })),
      e(mod('bb', { dependencies: { aa: '^1.0.0' } })),
      e(mod('cc', { dependencies: { aa: '^1.0.0' } })),
      e(mod('dd')),
    ]);
    expect(status(r, 'aa')).toMatchObject({ status: 'failed' });
    expect(status(r, 'aa').reason).toMatch(/cycle/);
    expect(status(r, 'bb').status).toBe('failed');
    expect(status(r, 'cc').status).toBe('skipped');
    expect(status(r, 'dd').status).toBe('resolved');
  });
  it('a self-dependency is an invalid definition', () => {
    const r = resolveModules([e(mod('aa', { dependencies: { aa: '^1.0.0' } }))]);
    expect(status(r, 'aa').status).toBe('failed');
  });
});

describe('collisions', () => {
  it('the same module id twice fails the later entry and names both', () => {
    const r = resolveModules([e(mod('todo', { version: '1.0.0' })), e(mod('todo', { version: '1.1.0' }), 'runtime'), e(mod('other', { dependencies: { todo: '^1.0.0' } }))]);
    expect(r.results[0]!.status).toBe('resolved');
    expect(r.results[1]!.status).toBe('failed');
    expect(r.results[1]!.reason).toMatch(/duplicate module id "todo".*1\.0\.0.*bundled.*1\.1\.0.*runtime/);
    expect(r.results[2]!.status).toBe('resolved');
    expect(r.order.map((x) => x.def.version)).toEqual(['1.0.0', '1.0.0']);
  });
});

describe('already active modules', () => {
  it('count as dependencies, with their version', () => {
    const known = new Map([['shared', { version: '1.4.0', ok: true }]]);
    const r = resolveModules([e(mod('late', { dependencies: { shared: '^1.2.0' } }))], known);
    expect(r.results[0]!.status).toBe('resolved');
    const bad = resolveModules([e(mod('late', { dependencies: { shared: '^2.0.0' } }))], known);
    expect(bad.results[0]!.status).toBe('failed');
  });
  it('failed or unavailable known modules skip the dependent', () => {
    const known = new Map([['shared', { version: '1.0.0', ok: false, reason: 'boom' }]]);
    const r = resolveModules([e(mod('late', { dependencies: { shared: '^1.0.0' } }))], known);
    expect(r.results[0]!.status).toBe('skipped');
    expect(r.results[0]!.reason).toMatch(/boom/);
  });
});
