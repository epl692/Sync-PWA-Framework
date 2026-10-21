// T077 (User Story 6, FR-011, FR-011a, FR-012): a private object inside a Space.
import { describe, expect, it } from 'vitest';
import { readPacketRecords, waitFor } from '@sync/testkit';
import { NotAuthorizedError, SPACE_CODEC_ID, parseHeader } from '../../src';
import { decodeEnvelope } from '@sync/core';
import { Forger } from '../forger';
import { buildFamily, settle } from '../family';

async function gift() {
  const f = await buildFamily();
  f.g.link('editor', 'viewer');
  // the Editor makes a private object shared only with the Viewer
  const viewerUser = f.viewer.spaces.session()!.user;
  const { object, share } = await f.editor.spaces.createInShare(f.space.id, 'gift', { idea: 'surprise party' }, [{ user: viewerUser, role: 'viewer' }]);
  return { f, object, share, viewerUser };
}

describe('override shares', () => {
  it('members of the share read it; Space members outside it store and relay it but cannot read it', async () => {
    const { f, object, share } = await gift();
    await waitFor(async () => (await f.viewer.core.get(object.id)) !== undefined, 12_000, 'the share member reads it');
    expect((await f.viewer.core.get(object.id))!.fields.idea).toBe('surprise party');
    await settle(f.g);

    for (const outsider of [f.owner, f.obs]) {
      expect(await outsider.core.get(object.id)).toBeUndefined();
      // it has the packets (stored, so it can relay them) but could not decode them
      const recs = (await readPacketRecords(outsider.storage)).filter((r) => {
        const env = decodeEnvelope(r.raw).env;
        return env.codec === SPACE_CODEC_ID && parseHeader(env.body)!.scope === share.shareId;
      });
      expect(recs.length).toBeGreaterThanOrEqual(1);
      expect(recs.every((r) => r.status === 'parked')).toBe(true);
    }
    await f.g.close();
  });

  it('gives the share its own members, roles and key: the packets name the share, not the Space', async () => {
    const { f, object, share } = await gift();
    const info = await f.editor.spaces.shareOf(object.id);
    expect(info).toMatchObject({ shareId: share.shareId, obj: object.id, myRole: 'owner' });
    expect(info!.members!.map((m) => m.role).sort()).toEqual(['owner', 'viewer']);
    expect((await f.viewer.spaces.shareOf(object.id))!.myRole).toBe('viewer');
    expect((await f.owner.spaces.shareOf(object.id))!.myRole).toBeUndefined(); // sees that a share exists, but is not in it
    expect((await f.owner.spaces.shareOf(object.id))!.members).toBeUndefined();
    const tail = await f.editor.core.update(object.id, { idea: 'balloons' });
    expect(tail.fields.idea).toBe('balloons');
    const last = (await readPacketRecords(f.editor.storage)).filter((r) => r.obj === object.id).at(-1)!;
    expect(parseHeader(decodeEnvelope(last.raw).env.body)!.scope).toBe(share.shareId);
    await f.g.close();
  });

  it('keeps Space Owners out: they cannot read or edit a share they are not in (FR-011a)', async () => {
    const { f, object, share } = await gift();
    await waitFor(async () => (await f.viewer.core.get(object.id)) !== undefined, 12_000, 'shared');
    await settle(f.g);
    await expect(f.owner.core.update(object.id, { idea: 'overruled' })).rejects.toThrow(); // it cannot even see the object
    // writing it with the Space key is refused by every peer that knows about the share
    const o = await Forger.of(f.owner);
    const smuggled = await o.packet(f.space.id, o.body('gift', { idea: 'overruled' }, object.id, 'update'));
    for (const peer of [f.editor, f.viewer, f.obs]) {
      const r = await peer.core.ingest(smuggled.raw, 'memory:owner');
      expect(r.status, peer.name).toBe('rejected');
    }
    expect((await f.viewer.core.get(object.id))!.fields.idea).toBe('surprise party');
    void share;
    await f.g.close();
  });

  it('enforces share roles: a share Viewer cannot write, and cannot be made more than a Viewer if it is only a Space Viewer', async () => {
    const { f, object, share, viewerUser } = await gift();
    await waitFor(async () => (await f.viewer.core.get(object.id)) !== undefined, 12_000, 'shared');
    await expect(f.viewer.core.update(object.id, { idea: 'mine now' })).rejects.toThrow(/role/);
    await expect(f.editor.spaces.setShareRole(share.shareId, viewerUser, 'editor')).rejects.toBeInstanceOf(NotAuthorizedError); // Space Viewer
    // a Space Editor can be
    await f.editor.spaces.setShareRole(share.shareId, f.owner.spaces.session()!.user, 'editor');
    await waitFor(async () => (await f.owner.core.get(object.id)) !== undefined, 12_000, 'the Owner, now in the share, reads it');
    const edited = await f.owner.core.update(object.id, { idea: 'cake' });
    expect(edited.fields.idea).toBe('cake');
    await waitFor(async () => (await f.viewer.core.get(object.id))?.fields.idea === 'cake', 12_000, 'the share Viewer sees the edit');
    await f.g.close();
  });

  it('only Space members can be added to a share, and only by a share Owner', async () => {
    const { f, object, share } = await gift();
    await expect(f.editor.spaces.setShareRole(share.shareId, 'someone-outside', 'viewer')).rejects.toBeInstanceOf(NotAuthorizedError);
    await expect(f.viewer.spaces.setShareRole(share.shareId, f.obs.spaces.session()!.user, 'viewer')).rejects.toBeInstanceOf(NotAuthorizedError);
    await expect(f.owner.spaces.share(object.id, [])).rejects.toBeInstanceOf(NotAuthorizedError); // already in a share
    await f.g.close();
  });

  it('removing a user from the Space removes them from every share, and the share key rotates', async () => {
    const { f, object, share, viewerUser } = await gift();
    await waitFor(async () => (await f.viewer.core.get(object.id)) !== undefined, 12_000, 'shared');
    f.g.link('owner', 'editor');
    await f.owner.spaces.remove(f.space.id, viewerUser);
    await waitFor(async () => (await f.editor.spaces.shareOf(object.id))!.members!.length === 1, 12_000, 'the share loses the member');
    // the share's Owner (the Editor) rotates the share key, not the Space Owner, who has no key for it
    await waitFor(async () => (await f.editor.core.query({ type: '$sys.epoch' }).once()).some((e) => e.fields.scope === share.shareId && e.fields.epoch === 1), 12_000, 'the share key rotates');
    await f.editor.core.update(object.id, { idea: 'after the removal' });
    await settle(f.g);
    expect((await f.viewer.core.get(object.id))!.fields.idea).toBe('surprise party'); // what it had, no more
    await f.g.close();
  });

  it('shares an object that already exists: new writes are private, the history before stays as it was', async () => {
    const f = await buildFamily();
    const obj = await f.editor.core.create(f.space.id, 'note', { text: 'public so far' });
    await waitFor(async () => (await f.owner.core.get(obj.id)) !== undefined, 8000, 'owner has it');
    await f.editor.spaces.share(obj.id, []); // only the Editor
    await f.editor.core.update(obj.id, { text: 'now private' });
    await settle(f.g);
    expect((await f.owner.core.get(obj.id))!.fields.text).toBe('public so far');
    expect((await f.editor.core.get(obj.id))!.fields.text).toBe('now private');
    await f.g.close();
  });
});
