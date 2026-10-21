// T085 (spec Edge Case): an invite QR photographed by someone else.
import { describe, expect, it } from 'vitest';
import { createSecureGroup, waitFor } from '@sync/testkit';
import type { JoinRequestView } from '@sync/spaces';
import { createInviteProvider } from '../../src';

describe('a photographed invite', () => {
  it('shows the Owner a different short code for the copy, and the Owner can decline it', async () => {
    const requests: JoinRequestView[] = [];
    const decisions: boolean[] = [true, false]; // the intended person first, then the stranger holding a copy
    const g = await createSecureGroup(['owner', 'friend', 'stranger'], {
      provider: () => createInviteProvider({ baseUrl: 'https://app.test/', joinTimeoutMs: 8000 }),
      approveJoin: (r) => (requests.push(r), decisions.shift() ?? false),
      rotationGraceMs: 20,
    });
    g.link('owner', 'friend');
    g.link('owner', 'stranger');
    const owner = g.node('owner');
    const space = await owner.spaces.create();
    const art = await owner.spaces.invite(space.id, { role: 'viewer', expiresAt: g.clock.now() + 3_600_000, maxUses: 5, approval: 'required' });

    const friendSas: string[] = [];
    const strangerSas: string[] = [];
    await g.node('friend').spaces.accept(art.url, { onSas: (s) => friendSas.push(s) });
    await expect(g.node('stranger').spaces.accept(art.url, { onSas: (s) => strangerSas.push(s) })).rejects.toMatchObject({ reason: 'declined' });

    expect(requests.map((r) => r.sas)).toEqual([friendSas[0], strangerSas[0]]); // each side sees the code the Owner is shown
    expect(friendSas[0]).not.toBe(strangerSas[0]); // so the Owner, who expects one person, can tell the copy apart
    expect((await owner.spaces.members(space.id)).map((m) => m.role).sort()).toEqual(['owner', 'viewer']);
    await waitFor(async () => (await g.node('friend').spaces.list()).length === 1, 10_000, 'friend joined');
    expect(await g.node('stranger').spaces.list()).toEqual([]);
    await g.close();
  });
});
