// T010 (S-1, spec 004): blob keys follow packet scoping in a real Space: Space keys, share keys, and no keys for outsiders.
import { describe, expect, it } from 'vitest';
import { buildFamily, settle } from '../family';

describe('S-1 blobKeys in a real Space', () => {
  it('uses the Space scope for ordinary objects and the share scope for a shared one, with different keys', async () => {
    const f = await buildFamily();
    f.g.link('editor', 'viewer');
    const plain = await f.editor.core.create(f.space.id, 'note', { x: 1 });
    const viewerUser = f.viewer.spaces.session()!.user;
    const { object, share } = await f.editor.spaces.createInShare(f.space.id, 'gift', { idea: 'x' }, [{ user: viewerUser, role: 'viewer' }]);
    await settle(f.g);

    const bk = f.editor.spaces.blobKeys;
    expect(bk.scopeFor(f.space.id, plain.id)).toBe(f.space.id);
    expect(bk.scopeFor(f.space.id, object.id)).toBe(share.shareId);

    const wSpace = (await bk.forWrite(f.space.id))!;
    const wShare = (await bk.forWrite(share.shareId))!;
    expect(wSpace.keyId).not.toBe(wShare.keyId);

    // a Space member outside the share has no keys for the share scope; a share member has
    expect(await f.owner.spaces.blobKeys.forWrite(share.shareId)).toBeUndefined();
    expect(await f.viewer.spaces.blobKeys.forRead(share.shareId, wShare.keyId)).toBeDefined();
    expect(await f.owner.spaces.blobKeys.forRead(f.space.id, wSpace.keyId)).toBeDefined();
    await f.g.close();
  });

  it('after a member is removed (rotation) new writes use the new epoch and older blobs stay readable', async () => {
    const f = await buildFamily();
    const before = (await f.owner.spaces.blobKeys.forWrite(f.space.id))!;
    await f.owner.spaces.remove(f.space.id, f.viewer.spaces.session()!.user);
    await settle(f.g, 6);
    const after = (await f.owner.spaces.blobKeys.forWrite(f.space.id))!;
    expect(after.epoch).toBeGreaterThan(before.epoch);
    expect(after.keyId).not.toBe(before.keyId);
    expect(await f.owner.spaces.blobKeys.forRead(f.space.id, before.keyId)).toBeDefined();
    // the removed viewer never gets the new epoch key
    expect(await f.viewer.spaces.blobKeys.forRead(f.space.id, after.keyId)).toBeUndefined();
    await f.g.close();
  });
});
