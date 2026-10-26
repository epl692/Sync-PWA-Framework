// T085 (US5): modules only touch the types and Spaces they declare (FR-012, research R-10).
import { describe, expect, it } from 'vitest';
import { createSecureNode } from '@sync/testkit';
import { createHost, type Host } from '../../src/host/host';
import { AccessDeniedError } from '../../src/access/errors';
import { Bindings, memoryBindingDb } from '../../src/access/bindings';
import type { HostEvent, ModuleContext, ModuleDefinition } from '../../src/types';
import { simpleType } from '../helpers';

const quiet = { info() {}, warn() {}, error() {} };

const owner: ModuleDefinition = { id: 'owner', version: '1.0.0', access: { spaces: { read: 'any', write: 'any' } }, provides: { types: [simpleType('item')] } };
const secret: ModuleDefinition = { id: 'vault', version: '1.0.0', access: { spaces: { read: 'any', write: 'any' } }, provides: { types: [simpleType('secret')] } };

async function setup(modules: ModuleDefinition[], opts: { signedIn?: boolean } = {}) {
  const node = await createSecureNode({ signUp: opts.signedIn !== false });
  const a = (await node.spaces.create('A')).id;
  const b = (await node.spaces.create('B')).id;
  const bindings = await Bindings.open(memoryBindingDb());
  const host: Host = createHost({ core: node.core, spaces: node.spaces, entries: modules.map((def) => ({ def, source: 'bundled' as const })), defineViews: false, log: quiet, bindings });
  const events: HostEvent[] = [];
  host.on((e) => void events.push(e));
  await host.start();
  const ctx = (id: string): ModuleContext => host.contextOf(id)!;
  return { node, host, a, b, events, ctx, bindings };
}

const denied = (p: Promise<unknown> | (() => unknown)) =>
  (typeof p === 'function' ? Promise.resolve().then(p) : p).then(
    () => undefined,
    (e) => e as Error,
  );

describe('types', () => {
  it('a module may always use its own types', async () => {
    const t = await setup([{ ...owner, access: { spaces: { read: 'any', write: 'any' } } }]);
    const o = await t.ctx('owner').data.create(t.a, 'owner.item', { title: 'x' });
    expect((await t.ctx('owner').data.get(o.id))!.fields.title).toBe('x');
  });

  it('another module’s type needs a declaration: read to read, write to write, and write implies read', async () => {
    const reader: ModuleDefinition = { id: 'reader', version: '1.0.0', access: { types: { read: ['owner.item'] }, spaces: { read: 'any', write: 'any' } } };
    const writer: ModuleDefinition = { id: 'writer', version: '1.0.0', access: { types: { write: ['owner.item'] }, spaces: { read: 'any', write: 'any' } } };
    const nobody: ModuleDefinition = { id: 'nobody', version: '1.0.0', access: { spaces: { read: 'any', write: 'any' } } };
    const t = await setup([owner, reader, writer, nobody]);
    const o = await t.ctx('owner').data.create(t.a, 'owner.item', { title: 'x' });

    expect(await denied(() => t.ctx('nobody').data.query({ type: 'owner.item' }).once())).toBeInstanceOf(AccessDeniedError);
    expect(await denied(t.ctx('nobody').data.get(o.id))).toBeUndefined(); // reads of what is not allowed look like "not found"
    expect(await denied(t.ctx('nobody').data.create(t.a, 'owner.item', { title: 'n' }))).toBeInstanceOf(AccessDeniedError);

    expect((await t.ctx('reader').data.query({ type: 'owner.item' }).once()).map((r) => r.id)).toEqual([o.id]);
    expect(await denied(t.ctx('reader').data.create(t.a, 'owner.item', { title: 'r' }))).toBeInstanceOf(AccessDeniedError);
    expect(await denied(t.ctx('reader').data.update(o.id, { title: 'r' }))).toBeInstanceOf(AccessDeniedError);

    expect((await t.ctx('writer').data.query({ type: 'owner.item' }).once())).toHaveLength(1); // write implies read
    const w = await t.ctx('writer').data.create(t.a, 'owner.item', { title: 'w' });
    await t.ctx('writer').data.update(w.id, { title: 'w2' });
    await t.ctx('writer').data.remove(w.id);
  });

  it('a query needs a type or an id', async () => {
    const t = await setup([owner]);
    const e = await denied(() => t.ctx('owner').data.query({ space: t.a }));
    expect(e).toBeInstanceOf(AccessDeniedError);
    expect(e!.message).toMatch(/type or an id/);
  });

  it('a query by id never returns objects of types the module may not read', async () => {
    const nobody: ModuleDefinition = { id: 'nobody', version: '1.0.0', access: { spaces: { read: 'any', write: 'any' } } };
    const t = await setup([owner, nobody]);
    const o = await t.ctx('owner').data.create(t.a, 'owner.item', { title: 'x' });
    expect(await t.ctx('nobody').data.query({ id: o.id }).once()).toEqual([]);
    expect(await t.ctx('owner').data.query({ id: o.id }).once()).toHaveLength(1);
  });

  it('update and remove give the same error for a missing object, an undeclared type and an unbound Space', async () => {
    const poke: ModuleDefinition = { id: 'poke', version: '1.0.0', access: { types: { write: ['owner.item'] }, spaces: { read: 'bound', write: 'bound' } } };
    const t = await setup([owner, secret, poke]);
    const hidden = await t.ctx('vault').data.create(t.a, 'vault.secret', { title: 's' }); // undeclared for poke
    const unbound = await t.ctx('owner').data.create(t.b, 'owner.item', { title: 'u' }); // declared type, Space not bound to poke
    await t.host.bindSpace('poke', t.a, 'rw');
    const errors = [
      await denied(t.ctx('poke').data.update('no-such-object', { title: 'x' })),
      await denied(t.ctx('poke').data.update(hidden.id, { title: 'x' })),
      await denied(t.ctx('poke').data.update(unbound.id, { title: 'x' })),
    ];
    for (const e of errors) expect(e).toBeInstanceOf(AccessDeniedError);
    const same = (e: Error, id: string) => e.message.replaceAll(id, '<id>');
    expect(same(errors[0]!, 'no-such-object')).toBe(same(errors[1]!, hidden.id));
    expect(same(errors[1]!, hidden.id)).toBe(same(errors[2]!, unbound.id));
    const removed = await denied(t.ctx('poke').data.remove(hidden.id));
    expect(same(removed!, hidden.id)).toBe(same(errors[1]!, hidden.id));
    expect((await t.node.core.get(hidden.id))!.fields.title).toBe('s'); // untouched
  });
});

describe('Spaces', () => {
  const bound: ModuleDefinition = { id: 'bound', version: '1.0.0', provides: { types: [simpleType('thing')] } }; // default: bound

  it('a bound module can use only the Spaces bound to it, in the bound mode', async () => {
    const t = await setup([bound]);
    expect(await denied(t.ctx('bound').data.create(t.a, 'bound.thing', { title: 'x' }))).toBeInstanceOf(AccessDeniedError);
    await t.host.bindSpace('bound', t.a, 'r');
    expect(await denied(t.ctx('bound').data.create(t.a, 'bound.thing', { title: 'x' }))).toBeInstanceOf(AccessDeniedError); // read-only
    await t.host.bindSpace('bound', t.a, 'rw');
    const o = await t.ctx('bound').data.create(t.a, 'bound.thing', { title: 'x' });
    expect(await denied(t.ctx('bound').data.create(t.b, 'bound.thing', { title: 'y' }))).toBeInstanceOf(AccessDeniedError);
    expect(await denied(() => t.ctx('bound').data.query({ type: 'bound.thing', space: t.b }).once())).toBeInstanceOf(AccessDeniedError);
    expect((await t.ctx('bound').data.query({ type: 'bound.thing', space: t.a }).once()).map((r) => r.id)).toEqual([o.id]);
  });

  it('a type query without a Space only shows rows from Spaces the module may read', async () => {
    const t = await setup([bound, owner]);
    await t.ctx('owner').data.create(t.b, 'owner.item', { title: 'elsewhere' });
    const mine = await t.ctx('owner').data.create(t.a, 'owner.item', { title: 'here' });
    const peek: ModuleDefinition = { id: 'peek', version: '1.0.0', access: { types: { read: ['owner.item'] } } };
    const t2 = await setup([owner, peek]);
    const x = await t2.ctx('owner').data.create(t2.a, 'owner.item', { title: 'a' });
    await t2.ctx('owner').data.create(t2.b, 'owner.item', { title: 'b' });
    await t2.host.bindSpace('peek', t2.a, 'r');
    expect((await t2.ctx('peek').data.query({ type: 'owner.item' }).once()).map((r) => r.id)).toEqual([x.id]);
    expect(mine.id).toBeDefined();
  });

  it('live queries follow binding changes', async () => {
    const peek: ModuleDefinition = { id: 'peek', version: '1.0.0', access: { types: { read: ['owner.item'] } } };
    const t = await setup([owner, peek]);
    await t.ctx('owner').data.create(t.a, 'owner.item', { title: 'a' });
    const seen: number[] = [];
    const unsub = t.ctx('peek').data.query({ type: 'owner.item' }).subscribe((rows) => void seen.push(rows.length));
    expect(seen).toEqual([0]);
    await t.host.bindSpace('peek', t.a, 'r');
    expect(seen.at(-1)).toBe(1);
    await t.host.unbindSpace('peek', t.a);
    expect(seen.at(-1)).toBe(0);
    unsub();
  });

  it('an any-module can use every Space', async () => {
    const t = await setup([owner]);
    await t.ctx('owner').data.create(t.a, 'owner.item', { title: 'a' });
    await t.ctx('owner').data.create(t.b, 'owner.item', { title: 'b' });
    expect(await t.ctx('owner').data.query({ type: 'owner.item' }).once()).toHaveLength(2);
  });

  it('ctx.spaces.list gives the Spaces the module may use for the mode', async () => {
    const t = await setup([bound, owner]);
    expect(await t.ctx('bound').spaces.list('r')).toEqual([]);
    await t.host.bindSpace('bound', t.a, 'r');
    expect(await t.ctx('bound').spaces.list('r')).toEqual([t.a]);
    expect(await t.ctx('bound').spaces.list('rw')).toEqual([]);
    await t.host.bindSpace('bound', t.b, 'rw');
    expect((await t.ctx('bound').spaces.list('rw'))).toEqual([t.b]);
    expect((await t.ctx('bound').spaces.list('r')).sort()).toEqual([t.a, t.b].sort());
    expect((await t.ctx('owner').spaces.list('rw')).sort()).toEqual([t.a, t.b].sort());
  });
});

describe('what a module can reach', () => {
  it('only the Spaces API with manage: true; never the core, keystore or signer', async () => {
    const plain: ModuleDefinition = { id: 'plain', version: '1.0.0' };
    const admin: ModuleDefinition = { id: 'admin', version: '1.0.0', access: { spaces: { manage: true } } };
    const t = await setup([plain, admin]);
    expect(t.ctx('plain').spaces.admin).toBeUndefined();
    expect(t.ctx('admin').spaces.admin).toBeDefined();
    for (const id of ['plain', 'admin']) {
      const ctx = t.ctx(id);
      expect(Object.keys(ctx).sort()).toEqual(['data', 'log', 'moduleId', 'settings', 'spaces', 'ui', 'version']);
      expect(Object.keys(ctx.data).sort()).toEqual(['create', 'get', 'history', 'query', 'remove', 'undo', 'update']);
      expect(Object.keys(ctx.spaces).sort()).toEqual(id === 'admin' ? ['admin', 'list'] : ['list']);
      const json = JSON.stringify(Object.keys(ctx));
      expect(json).not.toMatch(/core|keystore|signer|keys/i);
    }
  });
});

describe('denials are reported', () => {
  it('each denial emits access:denied with the module and what it tried', async () => {
    const nobody: ModuleDefinition = { id: 'nobody', version: '1.0.0', access: { spaces: { read: 'any', write: 'any' } } };
    const t = await setup([owner, nobody]);
    await denied(() => t.ctx('nobody').data.query({ type: 'owner.item' }).once());
    await denied(t.ctx('nobody').data.create(t.a, 'owner.item', { title: 'x' }));
    const found = t.events.filter((e) => e.kind === 'access:denied');
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ kind: 'access:denied', module: 'nobody', what: expect.stringContaining('read owner.item') });
    expect(found[1]).toMatchObject({ module: 'nobody', what: expect.stringContaining('write owner.item') });
  });
});
