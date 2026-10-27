// @vitest-environment jsdom
// T027: transactional activation and failure isolation (FR-003, research R-05).
import { describe, expect, it, vi } from 'vitest';
import { createTestCore, MemoryNetwork } from '@sync/testkit';
import { createHost } from '../../src/host/host';
import type { ResolveEntry } from '../../src/host/resolve';
import type { ModuleDefinition } from '../../src/types';
import { collectEvents, mod, simpleType } from '../helpers';

let n = 0;
const uid = () => `m${(++n).toString(36)}`;
const entry = (def: ModuleDefinition): ResolveEntry => ({ def, source: 'bundled' });

async function setup(defs: ModuleDefinition[], opts: Partial<Parameters<typeof createHost>[0]> = {}) {
  const t = await createTestCore();
  const registerType = vi.spyOn(t.core, 'registerType');
  const host = createHost({ core: t.core, entries: defs.map(entry), ...opts });
  const events = collectEvents(host);
  await host.start();
  const status = (id: string) => host.report().find((r) => r.id === id)!;
  return { t, core: t.core, host, events, registerType, status };
}

describe('activation', () => {
  it('commits types, resurrect flags, elements and features after activate completes', async () => {
    const id = uid();
    const order: string[] = [];
    let featureStarted = 0;
    const { host, registerType, status } = await setup([
      mod(id, {
        provides: {
          types: [simpleType('item', { merge: { editResurrects: true } }), simpleType('plain')],
          views: { list: () => class extends HTMLElement {} },
          features: [{ id: 'f', singleton: false, start: () => void featureStarted++ }],
        },
        activate: () => void order.push('activate'),
      }),
    ]);
    expect(status(id).status).toBe('active');
    expect(order).toEqual(['activate']);
    expect(host.registry.get(`${id}.item`)).toBeDefined();
    expect(registerType).toHaveBeenCalledWith(`${id}.item`, { resurrects: true });
    expect(registerType).toHaveBeenCalledWith(`${id}.plain`, { resurrects: false });
    expect(customElements.get(`${id}-list`)).toBeDefined();
    expect(featureStarted).toBe(1);
    expect(status(id).registers).toEqual({ types: [`${id}.item`, `${id}.plain`], views: [`${id}-list`], features: [`${id}.f`], transports: [], identityProviders: [] });
  });

  it('rolls back everything when activate throws, and reports why', async () => {
    const id = uid();
    let featureStarted = 0;
    const created: string[] = [];
    const { host, registerType, status, core, events } = await setup([
      mod(id, {
        provides: {
          types: [simpleType('item')],
          views: { list: () => class extends HTMLElement {} },
          features: [{ id: 'f', start: () => void featureStarted++ }],
          transports: [{ id: 'ws', create: () => (created.push('ws'), new MemoryNetwork().transport('x')) }],
        },
        activate: () => {
          throw new Error('kaboom');
        },
      }),
    ], { transports: [`${id}.ws`] });
    expect(status(id)).toMatchObject({ status: 'failed' });
    expect(status(id).reason).toMatch(/kaboom/);
    expect(host.registry.get(`${id}.item`)).toBeUndefined();
    expect(registerType).not.toHaveBeenCalled();
    expect(customElements.get(`${id}-list`)).toBeUndefined();
    expect(featureStarted).toBe(0);
    expect(created).toEqual([]);
    expect(core.transports()).toEqual([]);
    expect(events).toContainEqual({ kind: 'module:failed', id, reason: expect.stringContaining('kaboom') });
  });

  it('times out a hung activate and fails only that module', async () => {
    const hung = uid();
    const fine = uid();
    const { status } = await setup(
      [mod(hung, { activate: () => new Promise(() => {}) }), mod(fine)],
      { activateTimeoutMs: 20 },
    );
    expect(status(hung).status).toBe('failed');
    expect(status(hung).reason).toMatch(/timed out after 20 ?ms/);
    expect(status(fine).status).toBe('active');
  });

  it('runs activation hooks in dependency order and skips the dependents of a failure', async () => {
    const a = uid();
    const b = uid();
    const c = uid();
    const d = uid();
    const order: string[] = [];
    const { status } = await setup([
      mod(d, { dependencies: { [b]: '^1.0.0' }, activate: () => void order.push('d') }),
      mod(b, { dependencies: { [a]: '^1.0.0' }, activate: () => { order.push('b'); throw new Error('b broke'); } }),
      mod(a, { activate: () => void order.push('a') }),
      mod(c, { activate: () => void order.push('c') }),
    ]);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order).not.toContain('d');
    expect(status(a).status).toBe('active');
    expect(status(b).status).toBe('failed');
    expect(status(d).status).toBe('skipped');
    expect(status(d).reason).toMatch(new RegExp(`dependency "${b}"`));
    expect(status(c).status).toBe('active');
  });

  it('fails the module, and registers nothing, when an element name is already defined', async () => {
    const id = uid();
    customElements.define(`${id}-list`, class extends HTMLElement {});
    const { host, status, registerType } = await setup([mod(id, { provides: { types: [simpleType('item')], views: { list: () => class extends HTMLElement {} } } })]);
    expect(status(id).status).toBe('failed');
    expect(status(id).reason).toMatch(new RegExp(`${id}-list.*already defined`));
    expect(host.registry.get(`${id}.item`)).toBeUndefined();
    expect(registerType).not.toHaveBeenCalled();
  });

  it('fails the whole module when one of its schemas does not lint, registering none of them', async () => {
    const id = uid();
    const bad = { name: 'bad', versions: [] };
    const { host, status } = await setup([mod(id, { provides: { types: [simpleType('good'), bad] } })]);
    expect(status(id).status).toBe('failed');
    expect(status(id).reason).toMatch(/at least one version/);
    expect(host.registry.get(`${id}.good`)).toBeUndefined();
  });

  it('creates only the transports the app selected', async () => {
    const id = uid();
    const made: string[] = [];
    const net = new MemoryNetwork();
    const { core, status } = await setup(
      [mod(id, { provides: { transports: [
        { id: 'one', create: () => (made.push('one'), net.transport('n1', 'one')) },
        { id: 'two', create: () => (made.push('two'), net.transport('n1', 'two')) },
      ] } })],
      { transports: [`${id}.two`] },
    );
    expect(made).toEqual(['two']);
    expect(core.transports().map((t) => t.id)).toEqual(['two']);
    expect(status(id).registers.transports).toEqual([`${id}.one`, `${id}.two`]); // what the module declares
  });

  it('passes read-only settings and a logger to the module', async () => {
    const id = uid();
    let seen: unknown;
    await setup([mod(id, { activate: (ctx) => { seen = { settings: ctx.settings, id: ctx.moduleId, frozen: Object.isFrozen(ctx.settings) }; } })], { settings: { [id]: { greeting: 'hi' } } });
    expect(seen).toEqual({ settings: { greeting: 'hi' }, id, frozen: true });
  });

  it('reports declared access and registrations for every module, including failed ones', async () => {
    const ok = uid();
    const bad = uid();
    const { status } = await setup([
      mod(ok, { access: { types: { read: ['other.thing'] } }, provides: { types: [simpleType('item')] } }),
      mod(bad, { version: 'nope' }),
    ]);
    expect(status(ok).access.types.read).toEqual([`${ok}.item`, 'other.thing'].sort());
    expect(status(bad).status).toBe('failed');
    expect(status(bad).source).toBe('bundled');
  });
});
