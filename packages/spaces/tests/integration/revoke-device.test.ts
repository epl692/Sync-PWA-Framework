// T073 (User Story 4, scenario 3): a lost device is revoked from another one; its later packets are rejected and the keys rotate.
import { describe, expect, it } from 'vitest';
import { createSecureNode, readPacketRecords, waitFor } from '@sync/testkit';
import type { SecurityEvent } from '../../src';
import { Forger } from '../forger';
import { buildFamily, settle } from '../family';

async function withSecondDevice() {
  const f = await buildFamily({ extra: ['editor2'] });
  const e2 = f.g.node('editor2');
  f.g.link('editor', 'editor2');
  const { code } = await f.editor.spaces.linkDevice();
  await e2.spaces.joinAsDevice(code);
  await waitFor(async () => (await e2.spaces.list()).length === 1, 15_000, 'second device sees the Space');
  await settle(f.g);
  return { f, e2 };
}

describe('revoking a device', () => {
  it('rejects the lost device’s later packets and rotates the keys', async () => {
    const { f, e2 } = await withSecondDevice();
    f.g.link('owner', 'editor2');
    const events: SecurityEvent[] = [];
    f.owner.spaces.on((e) => events.push(e));
    const earlier = await e2.core.create(f.space.id, 'note', { text: 'before the loss' });
    await waitFor(
      async () => (await f.owner.core.get(earlier.id)) !== undefined,
      8000,
      'owner has the early note',
    );

    await f.editor.spaces.revokeDevice(e2.core.deviceId); // done from the other device
    await waitFor(
      () => events.some((e) => e.kind === 'key:rotated' && e.reason === 'device-revoked'),
      10_000,
      'an Owner rotates for the revoked device',
    );
    const members = await f.owner.spaces.members(f.space.id);
    const editorUser = members.find((m) => m.devices.some((d) => d.id === f.editor.core.deviceId))!;
    expect(editorUser.devices.map((d) => [d.id === e2.core.deviceId, d.active])).toEqual(
      expect.arrayContaining([
        [true, false],
        [false, true],
      ]),
    );
    expect(await f.editor.core.get(earlier.id)).toBeDefined(); // what was written before stays

    // whoever has the lost device writes on: every peer refuses
    const thief = await Forger.of(e2);
    const p = await thief.packet(f.space.id, thief.body('stolen', { x: 1 }));
    expect((await f.owner.core.ingest(p.raw, 'memory:thief')).status).toBe('rejected');
    // and it cannot read what is written now
    const fresh = await f.owner.core.create(f.space.id, 'note', { text: 'after the revocation' });
    await waitFor(
      async () => (await f.editor.core.get(fresh.id)) !== undefined,
      8000,
      'the other devices read it',
    );
    await settle(f.g);
    expect(await e2.core.get(fresh.id)).toBeUndefined();
    // the user's remaining device is unaffected
    const mine = await f.editor.core.create(f.space.id, 'note', { text: 'still here' });
    await waitFor(
      async () => (await f.owner.core.get(mine.id)) !== undefined,
      8000,
      'owner reads the remaining device',
    );
    await f.g.close();
  });

  it('lets an Owner remove a user whose only device was lost, and the person joins again with a new device', async () => {
    const f = await buildFamily();
    const lost = f.viewer;
    await f.owner.spaces.remove(f.space.id, lost.spaces.session()!.user);
    const again = await createSecureNode({ name: 'viewer-again', clock: f.g.clock });
    f.g.nodes['viewer-again'] = again;
    f.g.link('owner', 'viewer-again');
    const art = await f.owner.spaces.invite(f.space.id, {
      role: 'viewer',
      expiresAt: f.g.clock.now() + 3_600_000,
      maxUses: 1,
      approval: 'auto',
    });
    await again.spaces.accept(art.url);
    await waitFor(async () => (await again.spaces.list()).length === 1, 12_000, 'the person is back');
    expect(again.spaces.session()!.user).not.toBe(lost.spaces.session()!.user); // a new identity: recovery is out of scope
    expect((await f.owner.spaces.members(f.space.id)).map((m) => m.role).sort()).toEqual([
      'editor',
      'owner',
      'viewer',
      'viewer',
    ]);
    await f.g.close();
  });

  it('refuses to revoke a device that is not yours', async () => {
    const f = await buildFamily();
    await f.editor.spaces.revokeDevice(f.viewer.core.deviceId); // not one of the editor's devices: nothing happens
    await settle(f.g);
    const m = await f.owner.spaces.members(f.space.id);
    expect(m.flatMap((x) => x.devices).every((d) => d.active)).toBe(true);
    expect(
      (await readPacketRecords(f.owner.storage)).filter((r) => r.type === '$sys.device-revoke'),
    ).toHaveLength(0);
    await f.g.close();
  });
});
