// T066 (FR-008, FR-010, research R-09): rotation under concurrency, long absences and key exhaustion.
import { describe, expect, it } from 'vitest';
import { waitFor } from '@sync/testkit';
import type { SecurityEvent } from '../../src';
import { buildFamily, settle } from '../family';

const epochOf = async (n: { spaces: { list(): Promise<Array<{ currentEpoch: number }>> } }) =>
  (await n.spaces.list())[0]!.currentEpoch;

describe('key rotation', () => {
  it('a member who was offline across several rotations catches up on every key through normal sync (FR-010)', async () => {
    const f = await buildFamily({ extra: ['x1', 'x2'] });
    for (const n of ['x1', 'x2']) {
      const art = await f.owner.spaces.invite(f.space.id, {
        role: 'viewer',
        expiresAt: f.g.clock.now() + 3_600_000,
        maxUses: 1,
        approval: 'auto',
      });
      await f.g.node(n).spaces.accept(art.url);
    }
    await waitFor(async () => (await f.g.node('x2').spaces.list()).length === 1, 10_000, 'x2 joined');
    await settle(f.g);

    // the editor goes offline
    f.g.net.sever('owner', 'editor');
    await f.owner.spaces.remove(f.space.id, f.g.node('x1').spaces.session()!.user); // epoch 1
    await waitFor(async () => (await epochOf(f.owner)) === 1, 8000, 'epoch 1');
    const one = await f.owner.core.create(f.space.id, 'note', { text: 'written under epoch 1' });
    await f.owner.spaces.remove(f.space.id, f.g.node('x2').spaces.session()!.user); // epoch 2
    await waitFor(async () => (await epochOf(f.owner)) === 2, 8000, 'epoch 2');
    const two = await f.owner.core.create(f.space.id, 'note', { text: 'written under epoch 2' });

    f.g.net.restore('owner', 'editor');
    await waitFor(
      async () =>
        (await f.editor.core.get(one.id)) !== undefined && (await f.editor.core.get(two.id)) !== undefined,
      12_000,
      'the editor reads data from both epochs',
    );
    expect(await epochOf(f.editor)).toBe(2);
    // and can write under the newest key, read by the owner
    const mine = await f.editor.core.create(f.space.id, 'note', { text: 'back online' });
    await waitFor(
      async () => (await f.owner.core.get(mine.id)) !== undefined,
      8000,
      'owner reads the editor',
    );
    await f.g.close();
  });

  it('concurrent rotations by two Owners keep every key readable, and a later rotation covers both', async () => {
    const f = await buildFamily({ extra: ['o2', 'x1', 'x2'] });
    f.g.link('owner', 'o2');
    const art = await f.owner.spaces.invite(f.space.id, {
      role: 'owner',
      expiresAt: f.g.clock.now() + 3_600_000,
      maxUses: 1,
      approval: 'auto',
    });
    await f.g.node('o2').spaces.accept(art.url);
    for (const n of ['x1', 'x2']) {
      const a = await f.owner.spaces.invite(f.space.id, {
        role: 'viewer',
        expiresAt: f.g.clock.now() + 3_600_000,
        maxUses: 1,
        approval: 'auto',
      });
      await f.g.node(n).spaces.accept(a.url);
    }
    await waitFor(
      async () => (await f.g.node('o2').spaces.members(f.space.id)).length === 7,
      12_000,
      'o2 knows everyone',
    );
    await waitFor(async () => (await f.g.node('x2').spaces.list()).length === 1, 12_000, 'x2 joined');
    await settle(f.g);

    // partition: each Owner removes someone different while the other cannot hear
    f.g.net.sever('owner', 'o2');
    const o2 = f.g.node('o2');
    const x1 = f.g.node('x1').spaces.session()!.user;
    const x2 = f.g.node('x2').spaces.session()!.user;
    await Promise.all([f.owner.spaces.remove(f.space.id, x1), o2.spaces.remove(f.space.id, x2)]);
    const a = await f.owner.core.create(f.space.id, 'note', { text: 'under the first Owner’s key' });
    const b = await o2.core.create(f.space.id, 'note', { text: 'under the second Owner’s key' });

    f.g.net.restore('owner', 'o2');
    const everyone = [f.owner, o2, f.editor, f.viewer, f.obs];
    for (const n of everyone)
      await waitFor(
        async () => (await n.core.get(a.id)) !== undefined && (await n.core.get(b.id)) !== undefined,
        15_000,
        `${n.name} reads both notes`,
      );
    await settle(f.g, 5);
    // both removals happened after the first rotations: a further rotation must cover them
    await waitFor(
      async () => (await epochOf(f.owner)) >= 2 && (await epochOf(o2)) === (await epochOf(f.owner)),
      12_000,
      'a later epoch covers both removals',
    );
    const later = await f.owner.core.create(f.space.id, 'note', { text: 'after convergence' });
    for (const n of everyone)
      await waitFor(
        async () => (await n.core.get(later.id)) !== undefined,
        12_000,
        `${n.name} reads the later note`,
      );
    for (const gone of ['x1', 'x2']) expect(await f.g.node(gone).core.get(later.id)).toBeUndefined();
    await f.g.close();
  });

  it('rotates at the nonce-safety threshold, before a key can be used too often', async () => {
    const f = await buildFamily();
    const space = f.space.id;
    const keyId = (await f.owner.keyDb.all('epoch-keys'))
      .map((r) => r.value as { keyId: string; scope: string })
      .find((k) => k.scope === space)!.keyId;
    // written while the node is closed (closing flushes the old counters)
    const owner = await f.owner.reopen(() => f.owner.keyDb.put('counters', `${space}:${keyId}`, 2 ** 31 - 2));
    const events: SecurityEvent[] = [];
    owner.spaces.on((e) => events.push(e));
    await owner.core.create(space, 'note', { n: 1 }); // 2^31 - 1
    expect(events.some((e) => e.kind === 'key:rotated')).toBe(false);
    await owner.core.create(space, 'note', { n: 2 }); // 2^31: time to rotate
    await waitFor(
      () => events.some((e) => e.kind === 'key:rotated' && e.reason === 'key-exhausted'),
      8000,
      'key-exhausted rotation',
    );
    expect(await epochOf(owner)).toBe(1);
  });

  it('a manual removal grants nothing to the removed user’s devices', async () => {
    const f = await buildFamily();
    f.g.link('owner', 'editor');
    await f.owner.spaces.remove(f.space.id, f.editor.spaces.session()!.user);
    await settle(f.g);
    const grants = await f.owner.core.scanApplied(f.space.id, { typePrefix: '$sys.keygrant' });
    const targets = grants.map((g) => (g.body.fields as { to: string }).to);
    expect(targets).not.toContain(f.editor.core.deviceId);
    expect(targets).toContain(f.viewer.core.deviceId);
    expect(targets).toContain(f.obs.core.deviceId);
    await f.g.close();
  });
});
