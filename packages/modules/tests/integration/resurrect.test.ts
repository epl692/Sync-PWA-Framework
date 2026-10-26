// T052 (US2): "edit resurrects" is a per-type merge option.
import { describe, expect, it } from 'vitest';
import { createTestCore, remoteEnvelope } from '@sync/testkit';
import { createHost } from '../../src/host/host';
import { createFacade } from '../../src/access/facade';
import type { ModuleDefinition } from '../../src/types';

const field = { versions: [{ version: 1, fields: { v: { type: 'string' as const } } }] };
const docs: ModuleDefinition = {
  id: 'docs',
  version: '1.0.0',
  provides: { types: [{ name: 'live', ...field, merge: { editResurrects: true } }, { name: 'plain', ...field }] },
};

async function setup() {
  const t = await createTestCore();
  const host = createHost({ core: t.core, entries: [{ def: docs, source: 'bundled' }], defineViews: false, log: { info() {}, warn() {}, error() {} } });
  await host.start();
  await host.closeBootWindow();
  const facade = createFacade({ core: t.core, registry: host.registry, moduleId: 'docs', emit: () => {} });
  return { t, host, facade };
}

const packets = async (type: string, obj: string) => [
  await remoteEnvelope({ obj, op: 'create', type, fields: { v: 'start' } }, { author: 'CREATORDEVICE', seq: 1, wall: 100 }),
  await remoteEnvelope({ obj, op: 'delete', type, fields: {} }, { author: 'DELETERDEVICE', seq: 1, wall: 200 }),
  await remoteEnvelope({ obj, op: 'update', type, fields: { v: 'edited' } }, { author: 'EDITORDEVICE', seq: 1, wall: 300 }),
];

describe('editResurrects', () => {
  it('restores an object whose delete is concurrent with a later edit, in any arrival order', async () => {
    for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0]]) {
      const { t, facade } = await setup();
      const ps = await packets('docs.live', 'o1');
      for (const i of order) await t.core.ingest(ps[i]!.raw, 'p');
      expect((await facade.get('o1'))!.fields.v, `order ${order}`).toBe('edited');
    }
  });

  it('keeps the object deleted for a type that did not opt in', async () => {
    const { t, facade } = await setup();
    for (const e of await packets('docs.plain', 'o2')) await t.core.ingest(e.raw, 'p');
    expect(await facade.get('o2')).toBeUndefined();
  });

  it('peers with different registrations hold identical state (only visibility differs)', async () => {
    const { t } = await setup();
    const plain = await createTestCore();
    for (const e of await packets('docs.live', 'o3')) {
      await t.core.ingest(e.raw, 'p');
      await plain.core.ingest(e.raw, 'p');
    }
    expect(await t.core.stateHash('s1')).toBe(await plain.core.stateHash('s1'));
    expect(await plain.core.get('o3')).toBeUndefined();
    expect(await t.core.get('o3')).toBeDefined();
  });

  it('undo of a delete works for the opted-in type and is not undoable otherwise', async () => {
    const { t, facade } = await setup();
    const live = await facade.create('s1', 'docs.live', { v: '1' });
    const plain = await facade.create('s1', 'docs.plain', { v: '1' });
    t.clock.advance(10);
    await facade.remove(live.id);
    await facade.remove(plain.id);
    t.clock.advance(10);
    await facade.undo(live.id);
    expect((await facade.get(live.id))!.fields.v).toBe('1');
    await expect(facade.undo(plain.id)).rejects.toMatchObject({ code: 'not-undoable' });
  });
});
