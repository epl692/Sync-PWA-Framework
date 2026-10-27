// T036 (M-1, spec 004): ctx.blobs is the same engine behind an access check on declared Spaces.
import { describe, expect, it, vi } from 'vitest';
import { createSecureNode } from '@sync/testkit';
import type { Blobs, BlobRef } from '@sync/blobs';
import { Bindings, memoryBindingDb } from '../../src/access/bindings';
import { AccessDeniedError } from '../../src/access/errors';
import { createHost } from '../../src/host/host';
import type { HostEvent, ModuleContext, ModuleDefinition } from '../../src/types';
import { simpleType } from '../helpers';

const quiet = { info() {}, warn() {}, error() {} };

const ref = (space: string): BlobRef => ({ $blob: 1, id: 'A'.repeat(43), size: 10, type: 'image/png', space, scope: space, keyId: '0123456789abcdef' });

/** A Blobs engine that only records what the facade lets through. */
function fakeBlobs() {
  const calls: string[] = [];
  const rec =
    (name: string, ret?: unknown) =>
    (...args: unknown[]) => {
      calls.push(name);
      void args;
      return ret;
    };
  const engine = {
    attach: vi.fn(async (...a: unknown[]) => (calls.push('attach'), ref((a[1] as { space: string }).space))),
    observe: vi.fn(rec('observe', { get: () => ({}), subscribe: () => () => undefined })),
    request: vi.fn(async () => void calls.push('request')),
    open: vi.fn(async () => (calls.push('open'), new ReadableStream())),
    toBlob: vi.fn(async () => (calls.push('toBlob'), new Blob([]))),
    cancel: vi.fn(rec('cancel')),
    pin: vi.fn(async () => void calls.push('pin')),
    unpin: vi.fn(async () => void calls.push('unpin')),
  };
  return { engine: engine as unknown as Blobs, calls };
}

async function setup(modules: ModuleDefinition[], opts: { blobs?: boolean } = {}) {
  const node = await createSecureNode();
  const a = (await node.spaces.create('A')).id;
  const b = (await node.spaces.create('B')).id;
  const fake = fakeBlobs();
  const bindings = await Bindings.open(memoryBindingDb());
  const host = createHost({
    core: node.core,
    spaces: node.spaces,
    entries: modules.map((def) => ({ def, source: 'bundled' as const })),
    defineViews: false,
    log: quiet,
    bindings,
    ...(opts.blobs === false ? {} : { blobs: fake.engine }),
  });
  const events: HostEvent[] = [];
  host.on((e) => void events.push(e));
  await host.start();
  return { host, a, b, fake, events, bindings, ctx: (id: string): ModuleContext => host.contextOf(id)! };
}

const denied = (f: () => unknown) => Promise.resolve().then(f).then(() => undefined, (e) => e as Error);

const photos: ModuleDefinition = { id: 'photos', version: '1.0.0', access: { spaces: { read: 'bound', write: 'bound' } }, provides: { types: [simpleType('item')] } };

describe('ctx.blobs', () => {
  it('attach needs a Space the module may write; observe, request, open, toBlob, cancel, pin need one it may read', async () => {
    const t = await setup([photos]);
    await t.bindings.set('photos', t.a, 'rw');
    await t.bindings.set('photos', t.b, 'r');
    const blobs = t.ctx('photos').blobs!;
    expect(blobs).toBeDefined();
    const file = new Blob(['x']);

    await blobs.attach(file, { space: t.a, obj: 'o1' });
    expect(await denied(() => blobs.attach(file, { space: t.b, obj: 'o1' }))).toBeInstanceOf(AccessDeniedError); // read-only Space
    expect(await denied(() => blobs.attach(file, { space: 'unbound', obj: 'o1' }))).toBeInstanceOf(AccessDeniedError);

    blobs.observe(ref(t.b));
    await blobs.request(ref(t.b));
    await blobs.open(ref(t.b));
    await blobs.toBlob(ref(t.b));
    blobs.cancel(ref(t.b));
    await blobs.pin(ref(t.b));
    await blobs.unpin(ref(t.b));
    expect(t.fake.calls).toEqual(['attach', 'observe', 'request', 'open', 'toBlob', 'cancel', 'pin', 'unpin']);

    const other = ref('someone-elses-space');
    expect(await denied(() => blobs.observe(other))).toBeInstanceOf(AccessDeniedError);
    for (const m of ['request', 'open', 'toBlob', 'pin', 'unpin'] as const) {
      expect(await denied(() => blobs[m](other)), m).toBeInstanceOf(AccessDeniedError);
    }
    expect(await denied(() => blobs.cancel(other))).toBeInstanceOf(AccessDeniedError);
    expect(t.fake.calls).toHaveLength(8); // nothing from the denied calls reached the engine
    expect(t.events.filter((e) => e.kind === 'access:denied').length).toBeGreaterThanOrEqual(9);
  });

  it('with Spaces declared "any" every Space of the user is allowed', async () => {
    const t = await setup([{ ...photos, access: { spaces: { read: 'any', write: 'any' } } }]);
    const blobs = t.ctx('photos').blobs!;
    await blobs.attach(new Blob(['x']), { space: t.a, obj: 'o1' });
    await blobs.attach(new Blob(['x']), { space: t.b, obj: 'o1' });
    expect(t.fake.calls).toEqual(['attach', 'attach']);
  });

  it('is absent for a module that has no types to read or write (nothing to attach to), and when blobs are not enabled', async () => {
    const none: ModuleDefinition = { id: 'plain', version: '1.0.0' };
    const t = await setup([photos, none]);
    expect(t.ctx('photos').blobs).toBeDefined();
    expect(t.ctx('plain').blobs).toBeUndefined();
    const off = await setup([photos], { blobs: false });
    expect(off.ctx('photos').blobs).toBeUndefined();
  });

  it('is frozen with the rest of the context', async () => {
    const t = await setup([photos]);
    expect(Object.isFrozen(t.ctx('photos'))).toBe(true);
    expect(Object.isFrozen(t.ctx('photos').blobs)).toBe(true);
  });
});
