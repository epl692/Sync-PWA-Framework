// T070 (FR-005): when two Owners make conflicting offline changes, the earlier wins everywhere and the
// author of the ignored change is told.
import { describe, expect, it } from 'vitest';
import { waitFor } from '@sync/testkit';
import type { SecurityEvent } from '../../src';
import { buildFamily, settle } from '../family';

describe('conflicting membership changes between two Owners', () => {
  it('each removes the other while apart: one Owner remains on every peer, and only the loser is notified', async () => {
    const f = await buildFamily({ extra: ['o2'] });
    const o2 = f.g.node('o2');
    const art = await f.owner.spaces.invite(f.space.id, {
      role: 'owner',
      expiresAt: f.g.clock.now() + 3_600_000,
      maxUses: 1,
      approval: 'auto',
    });
    await o2.spaces.accept(art.url);
    await waitFor(
      async () => (await o2.spaces.members(f.space.id)).length === 5,
      12_000,
      'second Owner knows everyone',
    );
    await settle(f.g);

    f.g.net.sever('owner', 'o2');
    const heard: Record<string, SecurityEvent[]> = { owner: [], o2: [] };
    f.owner.spaces.on((e) => heard.owner!.push(e));
    o2.spaces.on((e) => heard.o2!.push(e));
    await f.owner.spaces.remove(f.space.id, o2.spaces.session()!.user);
    await o2.spaces.remove(f.space.id, f.owner.spaces.session()!.user);
    f.g.net.restore('owner', 'o2');
    f.g.link('o2', 'editor');
    f.g.link('o2', 'viewer');

    const everyone = [f.owner, o2, f.editor, f.viewer];
    await waitFor(
      async () => {
        const views = await Promise.all(
          everyone.map(async (n) =>
            JSON.stringify((await n.spaces.members(f.space.id)).map((m) => [m.user, m.role])),
          ),
        );
        return views.every((v) => v === views[0]);
      },
      15_000,
      'every peer agrees on the members',
    );
    await settle(f.g, 4);

    const owners = (await f.editor.spaces.members(f.space.id)).filter((m) => m.role === 'owner');
    expect(owners).toHaveLength(1);
    const winner = owners[0]!.user === f.owner.spaces.session()!.user ? 'owner' : 'o2';
    const loser = winner === 'owner' ? 'o2' : 'owner';
    const ignored = (name: string) => heard[name]!.filter((e) => e.kind === 'member:change-ignored');
    // the loser wrote a removal and (acting on it) a key rotation; neither counted, and it is told about each
    expect(ignored(loser).length).toBeGreaterThanOrEqual(1);
    expect(
      ignored(loser).some(
        (e) => e.kind === 'member:change-ignored' && e.type === '$sys.member' && e.space === f.space.id,
      ),
    ).toBe(true);
    expect(ignored(winner)).toHaveLength(0);
    await f.g.close();
  });
});
