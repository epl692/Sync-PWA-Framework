// T072 (User Story 4): a second device of the same user receives every Space and acts as the same user.
import { describe, expect, it } from 'vitest';
import { createSecureGroup, createSecureNode, waitFor } from '@sync/testkit';
import { createInviteProvider } from '../../src';

const provider = () => createInviteProvider({ baseUrl: 'https://app.test/', joinTimeoutMs: 8000 });

describe('linking another device', () => {
  it('gives the new device its own key under the same user, with all Spaces, shares and history', async () => {
    const g = await createSecureGroup(['phone', 'tablet', 'friend'], { provider, approveJoin: () => true, rotationGraceMs: 20 });
    // the tablet is a brand new install: no account yet
    const fresh = await createSecureNode({ name: 'tablet', clock: g.clock, provider, signUp: false });
    g.nodes.tablet = fresh;
    g.link('phone', 'tablet');
    g.link('phone', 'friend');
    const phone = g.node('phone');
    const friend = g.node('friend');

    const home = await phone.spaces.create('Home');
    const work = await phone.spaces.create('Work');
    const homeNote = await phone.core.create(home.id, 'note', { text: 'in Home' });
    const art = await phone.spaces.invite(home.id, { role: 'editor', expiresAt: g.clock.now() + 3_600_000, maxUses: 1, approval: 'auto' });
    await friend.spaces.accept(art.url);
    await waitFor(async () => (await friend.spaces.list()).length === 1, 10_000, 'friend joined');
    const secret = await phone.spaces.createInShare(home.id, 'note', { text: 'phone and friend only' }, [{ user: friend.spaces.session()!.user, role: 'editor' }]);

    const { code, done } = await phone.spaces.linkDevice();
    const session = await fresh.spaces.joinAsDevice(code);
    expect(session.user).toBe(phone.spaces.session()!.user);
    expect(session.device.deviceId).toBe(fresh.core.deviceId);
    expect(fresh.core.deviceId).not.toBe(phone.core.deviceId); // its own device key
    expect((await done).device).toBe(fresh.core.deviceId);

    await waitFor(async () => (await fresh.spaces.list()).length === 2, 15_000, 'the tablet sees both Spaces');
    expect((await fresh.spaces.list()).map((s) => [s.name, s.myRole]).sort()).toEqual([['Home', 'owner'], ['Work', 'owner']]);
    await waitFor(async () => (await fresh.core.get(homeNote.id)) !== undefined && (await fresh.core.get(secret.object.id)) !== undefined, 15_000, 'tablet reads history, including the private share');
    expect((await fresh.core.get(secret.object.id))!.fields.text).toBe('phone and friend only');

    // its writes are attributed to the same user and verified with its own key
    const mine = await fresh.core.create(work.id, 'note', { text: 'from the tablet' });
    await waitFor(async () => (await phone.core.get(mine.id)) !== undefined, 10_000, 'phone reads the tablet write');
    const members = await phone.spaces.members(work.id);
    expect(members).toHaveLength(1);
    expect(members[0]!.devices.map((d) => d.id).sort()).toEqual([phone.core.deviceId, fresh.core.deviceId].sort());
    const env = (await phone.core.scanApplied(work.id)).find((x) => x.body.obj === mine.id)!.env;
    expect(env.author).toBe(fresh.core.deviceId);
    await g.close();
  });

  it('works for a user who is only a Viewer: devices are self-service whatever the role', async () => {
    const g = await createSecureGroup(['owner', 'viewer'], { provider, approveJoin: () => true, rotationGraceMs: 20 });
    const second = await createSecureNode({ name: 'viewer2', clock: g.clock, provider, signUp: false });
    g.nodes.viewer2 = second;
    g.link('owner', 'viewer');
    g.link('viewer', 'viewer2');
    g.link('owner', 'viewer2');
    const owner = g.node('owner');
    const viewer = g.node('viewer');
    const space = await owner.spaces.create();
    const note = await owner.core.create(space.id, 'note', { text: 'hello' });
    await viewer.spaces.accept((await owner.spaces.invite(space.id, { role: 'viewer', expiresAt: g.clock.now() + 3_600_000, maxUses: 1, approval: 'auto' })).url);
    await waitFor(async () => (await viewer.spaces.list()).length === 1, 10_000, 'viewer joined');

    const { code } = await viewer.spaces.linkDevice();
    await second.spaces.joinAsDevice(code);
    await waitFor(async () => (await second.core.get(note.id)) !== undefined && (await second.spaces.list()).length === 1, 15_000, 'second device reads');
    expect((await second.spaces.list())[0]!.myRole).toBe('viewer');
    await expect(second.core.create(space.id, 'note', { text: 'no' })).rejects.toThrow(/role/);
    await g.close();
  });

  it('is refused when the user declines the link, and links nothing', async () => {
    const g = await createSecureGroup(['phone'], { provider, rotationGraceMs: 20 });
    // a phone that declines every link request
    const phone = await createSecureNode({ name: 'phone2', clock: g.clock, provider, approveLink: () => false });
    const fresh = await createSecureNode({ name: 'tablet', clock: g.clock, provider, signUp: false });
    g.nodes.phone2 = phone;
    g.nodes.tablet = fresh;
    g.link('phone2', 'tablet');
    const space = await phone.spaces.create();
    const { code, done } = await phone.spaces.linkDevice();
    done.catch(() => undefined);
    await expect(fresh.spaces.joinAsDevice(code)).rejects.toThrow(/refused|declined/);
    expect(fresh.spaces.session()).toBeUndefined();
    expect((await phone.spaces.members(space.id))[0]!.devices).toHaveLength(1);
    await g.close();
  });

  it('refuses a damaged or foreign code', async () => {
    const g = await createSecureGroup(['phone'], { provider });
    const fresh = await createSecureNode({ name: 'tablet', clock: g.clock, provider, signUp: false });
    await expect(fresh.spaces.joinAsDevice('not a code')).rejects.toThrow();
    await expect(fresh.spaces.joinAsDevice('sync-link:AAAA')).rejects.toThrow();
    expect(fresh.spaces.session()).toBeUndefined();
    await g.close();
  });
});
