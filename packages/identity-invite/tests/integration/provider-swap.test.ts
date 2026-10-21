// T083 (User Story 7, SC-005): the same Spaces behavior with the default provider and the stub provider, no other code changed.
import { describe, expect, it } from 'vitest';
import { createSecureGroup, createStubIdentityProvider, waitFor } from '@sync/testkit';
import { createInviteProvider } from '../../src';

describe.each([
  ['invite-qr (default)', () => createInviteProvider({ baseUrl: 'https://app.test/', joinTimeoutMs: 8000 })],
  ['stub', createStubIdentityProvider],
])('Spaces with the %s provider', (_name, provider) => {
  it('creates, invites, shares, removes and rotates exactly the same way', async () => {
    const g = await createSecureGroup(['owner', 'editor', 'viewer'], { provider, approveJoin: () => true, rotationGraceMs: 20 });
    g.link('owner', 'editor');
    g.link('owner', 'viewer');
    g.link('editor', 'viewer');
    const { owner, editor, viewer } = { owner: g.node('owner'), editor: g.node('editor'), viewer: g.node('viewer') };

    // US1: an encrypted Space
    const space = await owner.spaces.create('Swap');
    expect(space).toMatchObject({ myRole: 'owner', currentEpoch: 0 });

    // US3: invites
    for (const [node, role] of [[editor, 'editor'], [viewer, 'viewer']] as const) {
      const art = await owner.spaces.invite(space.id, { role, expiresAt: g.clock.now() + 3_600_000, maxUses: 1, approval: 'required' });
      expect(await node.spaces.accept(art.url)).toEqual({ space: space.id, role });
    }
    await waitFor(async () => (await viewer.spaces.list()).length === 1 && (await editor.spaces.list()).length === 1, 12_000, 'both joined');

    // US2: roles are enforced
    const n = await editor.core.create(space.id, 'note', { text: 'hi' });
    await waitFor(async () => (await viewer.core.get(n.id)) !== undefined && (await owner.core.get(n.id)) !== undefined, 12_000, 'note everywhere');
    await expect(viewer.core.create(space.id, 'note', { text: 'no' })).rejects.toThrow(/role/);

    // US6: a private object
    const { object } = await editor.spaces.createInShare(space.id, 'gift', { idea: 'x' }, [{ user: owner.spaces.session()!.user, role: 'viewer' }]);
    await waitFor(async () => (await owner.core.get(object.id)) !== undefined, 12_000, 'share member reads');
    expect(await viewer.core.get(object.id)).toBeUndefined();

    // US5: removal rotates the key and cuts the member off
    await owner.spaces.remove(space.id, viewer.spaces.session()!.user);
    expect((await owner.spaces.list())[0]!.currentEpoch).toBe(1);
    const later = await owner.core.create(space.id, 'note', { text: 'after' });
    await waitFor(async () => (await editor.core.get(later.id)) !== undefined, 12_000, 'remaining member reads');
    await new Promise((r) => setTimeout(r, 200));
    expect(await viewer.core.get(later.id)).toBeUndefined();
    await g.close();
  });
});
