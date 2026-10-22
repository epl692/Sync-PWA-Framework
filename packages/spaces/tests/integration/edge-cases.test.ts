// T085 (quickstart S10): the spec's Edge Cases that no other test spells out.
import { describe, expect, it } from 'vitest';
import { waitFor } from '@sync/testkit';
import { buildFamily, settle } from '../family';

describe('edge cases', () => {
  it('an invite expires even if nobody revoked it, and a revoked one cannot be revived', async () => {
    const f = await buildFamily({ extra: ['late'] });
    f.g.link('owner', 'late');
    const art = await f.owner.spaces.invite(f.space.id, {
      role: 'viewer',
      expiresAt: f.g.clock.now() + 1000,
      maxUses: 1,
      approval: 'auto',
    });
    f.g.clock.advance(5000);
    await expect(f.g.node('late').spaces.accept(art.url, { timeoutMs: 5000 })).rejects.toMatchObject({
      reason: 'expired',
    });
    await f.g.close();
  });

  it('two Owners, one lost device: the Space is not left ownerless', async () => {
    const f = await buildFamily();
    const editorUser = f.editor.spaces.session()!.user;
    await f.owner.spaces.setRole(f.space.id, editorUser, 'owner');
    await waitFor(async () => (await f.editor.spaces.list())[0]?.myRole === 'owner', 8000, 'second Owner');
    // the first Owner's device is lost: the second Owner removes that user
    await f.editor.spaces.remove(f.space.id, f.owner.spaces.session()!.user);
    await settle(f.g);
    expect((await f.editor.spaces.members(f.space.id)).filter((m) => m.role === 'owner')).toHaveLength(1);
    await f.g.close();
  });
});
