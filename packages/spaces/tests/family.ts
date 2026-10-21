/** A real Space: Owner, Editor, Viewer joined by invite, plus an observer that only hears from the Owner. */
import { createSecureGroup, waitFor, type SecureGroup } from '@sync/testkit';
import type { SpaceInfo } from '../src';

export interface Family {
  g: SecureGroup;
  space: SpaceInfo;
  owner: SecureGroup['nodes'][string];
  editor: SecureGroup['nodes'][string];
  viewer: SecureGroup['nodes'][string];
  obs: SecureGroup['nodes'][string];
}

export async function buildFamily(
  opts: { extra?: string[]; rotationGraceMs?: number } = {},
): Promise<Family> {
  const g = await createSecureGroup(['owner', 'editor', 'viewer', 'obs', ...(opts.extra ?? [])], {
    rotationGraceMs: opts.rotationGraceMs ?? 20,
  });
  const [owner, editor, viewer, obs] = ['owner', 'editor', 'viewer', 'obs'].map((n) => g.node(n)) as [
    Family['owner'],
    Family['owner'],
    Family['owner'],
    Family['owner'],
  ];
  for (const n of ['editor', 'viewer', 'obs', ...(opts.extra ?? [])]) g.link('owner', n);
  const space = await owner.spaces.create('Family');
  for (const [node, role] of [
    [editor, 'editor'],
    [viewer, 'viewer'],
  ] as const) {
    const art = await owner.spaces.invite(space.id, {
      role,
      expiresAt: g.clock.now() + 3_600_000,
      maxUses: 1,
      approval: 'auto',
    });
    await node.spaces.accept(art.url);
  }
  // the observer joins as a viewer too, so it holds the key and can read what the Owner relays
  const art = await owner.spaces.invite(space.id, {
    role: 'viewer',
    expiresAt: g.clock.now() + 3_600_000,
    maxUses: 1,
    approval: 'auto',
  });
  await obs.spaces.accept(art.url);
  for (const n of [editor, viewer, obs])
    await waitFor(async () => (await n.spaces.list()).length === 1, 10_000, `${n.name} sees the Space`);
  await settle(g);
  return { g, space, owner, editor, viewer, obs };
}

export async function settle(g: SecureGroup, rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    for (const n of Object.values(g.nodes)) await n.spaces.idle();
    await new Promise((r) => setTimeout(r, 30));
  }
}
