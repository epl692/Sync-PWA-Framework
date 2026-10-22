// T056 (User Story 3): the default provider, the real framework, a real encrypted Space.
import { describe, expect, it } from 'vitest';
import { JoinDeniedError, type JoinRequestView, type SecurityEvent } from '@sync/spaces';
import { createSecureGroup, readPacketRecords, waitFor, type SecureGroup } from '@sync/testkit';
import { createInviteProvider } from '../../src';

const provider = () => createInviteProvider({ baseUrl: 'https://app.test/', joinTimeoutMs: 8000 });

async function setup(
  opts: { approve?: (r: JoinRequestView) => boolean | Promise<boolean>; names?: string[] } = {},
) {
  const requests: JoinRequestView[] = [];
  const g = await createSecureGroup(opts.names ?? ['owner', 'joiner'], {
    provider,
    approveJoin: (r) => (requests.push(r), opts.approve ? opts.approve(r) : true),
    rotationGraceMs: 20,
  });
  g.link('owner', 'joiner');
  const owner = g.node('owner');
  const space = await owner.spaces.create('Family');
  return { g, owner, joiner: g.node('joiner'), space, requests };
}

const invite = (
  g: SecureGroup,
  owner: ReturnType<SecureGroup['node']>,
  space: string,
  over: Record<string, unknown> = {},
) =>
  owner.spaces.invite(space, {
    role: 'editor',
    expiresAt: g.clock.now() + 3_600_000,
    maxUses: 1,
    ...over,
  } as never);

const outcome = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'accepted';
  } catch (e) {
    return e instanceof JoinDeniedError ? e.reason : `error: ${(e as Error).message}`;
  }
};

describe('invites', () => {
  it('require approval by default: the Owner sees a request with a short code, the joiner sees the same code', async () => {
    const { g, owner, joiner, space, requests } = await setup();
    const art = await invite(g, owner, space.id);
    const res = await joiner.spaces.accept(art.url);
    expect(res).toEqual({ space: space.id, role: 'editor' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ space: space.id, inviteId: art.inviteId, role: 'editor' });
    expect(requests[0]!.sas.split('-')).toHaveLength(5);
    await waitFor(async () => (await joiner.spaces.list()).length === 1, 8000, 'joiner sees the Space');
    expect((await joiner.spaces.list())[0]).toMatchObject({ id: space.id, myRole: 'editor' });
    await g.close();
  });

  it('show the joiner the same short code while the Owner decides', async () => {
    let release!: (v: boolean) => void;
    const decision = new Promise<boolean>((r) => (release = r));
    const { g, owner, joiner, space, requests } = await setup({ approve: () => decision });
    const art = await invite(g, owner, space.id);
    const joinerSas: string[] = [];
    const accepting = joiner.spaces.accept(art.url, { onSas: (s) => joinerSas.push(s) });
    await waitFor(
      () => requests.length === 1 && joinerSas.length === 1,
      8000,
      'approval request and the joiner’s code',
    );
    expect(joinerSas[0]).toBe(requests[0]!.sas);
    expect(joinerSas[0]).toMatch(/^[a-z]+(-[a-z]+){4}$/);
    release(true);
    expect(await accepting).toEqual({ space: space.id, role: 'editor' });
    await g.close();
  });

  it('are accepted without a prompt when the Owner chose automatic approval', async () => {
    const { g, owner, joiner, space, requests } = await setup();
    const art = await invite(g, owner, space.id, { approval: 'auto' });
    expect(await outcome(joiner.spaces.accept(art.url))).toBe('accepted');
    expect(requests).toHaveLength(0);
    await g.close();
  });

  it('are refused when the Owner declines, and nothing is written', async () => {
    const { g, owner, joiner, space } = await setup({ approve: () => false });
    const art = await invite(g, owner, space.id);
    const before = (await readPacketRecords(owner.storage)).length;
    expect(await outcome(joiner.spaces.accept(art.url))).toBe('declined');
    await new Promise((r) => setTimeout(r, 100));
    expect((await readPacketRecords(owner.storage)).length).toBe(before);
    expect((await owner.spaces.members(space.id)).map((m) => m.role)).toEqual(['owner']);
    expect(await joiner.spaces.list()).toEqual([]);
    await g.close();
  });

  it('are refused when expired, revoked, used up, unknown or not an invite at all', async () => {
    const { g, owner, joiner, space } = await setup({ names: ['owner', 'joiner', 'second'] });
    g.link('owner', 'second');
    const second = g.node('second');
    const expired = await invite(g, owner, space.id);
    g.clock.advance(2 * 3_600_000);
    expect(await outcome(joiner.spaces.accept(expired.url))).toBe('expired');
    g.clock.advance(-2 * 3_600_000);

    const revoked = await invite(g, owner, space.id);
    await owner.spaces.revokeInvite(space.id, revoked.inviteId);
    expect(await outcome(joiner.spaces.accept(revoked.url))).toBe('revoked');

    const single = await invite(g, owner, space.id, { approval: 'auto' });
    expect(await outcome(joiner.spaces.accept(single.url))).toBe('accepted');
    expect(await outcome(second.spaces.accept(single.url))).toBe('used-up');

    expect(await outcome(second.spaces.accept('not an invite'))).toBe('unknown');
    await g.close();
  });

  it('let the joiner read the Space’s existing history and write according to its role', async () => {
    const { g, owner, joiner, space } = await setup();
    const note = await owner.core.create(space.id, 'note', { text: 'written before the invite' });
    const art = await invite(g, owner, space.id, { approval: 'auto' });
    await joiner.spaces.accept(art.url);
    await waitFor(async () => (await joiner.core.get(note.id)) !== undefined, 10_000, 'joiner reads history');
    expect((await joiner.core.get(note.id))!.fields.text).toBe('written before the invite');
    const mine = await joiner.core.create(space.id, 'note', { text: 'from the joiner' });
    await waitFor(
      async () => (await owner.core.get(mine.id)) !== undefined,
      10_000,
      'owner reads the joiner write',
    );
    await g.close();
  });

  it('give a joiner every key epoch: data from before a rotation is readable too', async () => {
    const { g, owner, joiner, space } = await setup({ names: ['owner', 'joiner', 'leaver'] });
    g.link('owner', 'leaver');
    const leaver = g.node('leaver');
    const a = await invite(g, owner, space.id, { approval: 'auto' });
    await leaver.spaces.accept(a.url);
    const oldNote = await owner.core.create(space.id, 'note', { text: 'epoch zero' });
    await owner.spaces.remove(space.id, leaver.spaces.session()!.user); // rotates to epoch 1
    await waitFor(async () => (await owner.spaces.list())[0]!.currentEpoch === 1, 8000, 'rotation');
    const newNote = await owner.core.create(space.id, 'note', { text: 'epoch one' });
    const b = await invite(g, owner, space.id, { approval: 'auto' });
    await joiner.spaces.accept(b.url);
    await waitFor(
      async () =>
        (await joiner.core.get(newNote.id)) !== undefined &&
        (await joiner.core.get(oldNote.id)) !== undefined,
      10_000,
      'joiner reads both',
    );
    expect((await joiner.core.get(oldNote.id))!.fields.text).toBe('epoch zero');
    expect((await joiner.core.get(newNote.id))!.fields.text).toBe('epoch one');
    await g.close();
  });

  it('are idempotent for a device that is already a member: no second membership is recorded', async () => {
    const { g, owner, joiner, space } = await setup();
    const art = await invite(g, owner, space.id, { approval: 'auto', maxUses: 3 });
    await joiner.spaces.accept(art.url);
    const members = (await owner.spaces.members(space.id)).length;
    const events = (await owner.core.query({ type: '$sys.member' }).once()).length;
    expect(await outcome(joiner.spaces.accept(art.url))).toBe('accepted');
    expect((await owner.spaces.members(space.id)).length).toBe(members);
    expect((await owner.core.query({ type: '$sys.member' }).once()).length).toBe(events);
    await g.close();
  });

  it('refuse a role invite from a non-Owner and a bad spec', async () => {
    const { g, owner, joiner, space } = await setup();
    await expect(
      joiner.spaces.invite(space.id, { role: 'viewer', expiresAt: g.clock.now() + 1000, maxUses: 1 }),
    ).rejects.toThrow();
    await expect(
      owner.spaces.invite(space.id, { role: 'viewer', expiresAt: g.clock.now() + 1000, maxUses: 0 }),
    ).rejects.toThrow(/maxUses/);
    await expect(
      owner.spaces.invite(space.id, { role: 'viewer', expiresAt: g.clock.now() - 1, maxUses: 1 }),
    ).rejects.toThrow(/future/);
    await g.close();
  });
});

void ({} as SecurityEvent);
