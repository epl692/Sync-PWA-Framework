// T065 (User Story 5, SC-003): removing a member rotates the keys; the removed device reads nothing new.
import { describe, expect, it } from 'vitest';
import { readPacketRecords, waitFor } from '@sync/testkit';
import { NotAuthorizedError, type SecurityEvent } from '../../src';
import { Forger } from '../forger';
import { buildFamily, settle } from '../family';

describe('removing a member', () => {
  it('rotates the Space key, and 100% of later packets are unreadable on the removed device', async () => {
    const f = await buildFamily();
    f.g.link('owner', 'editor'); // the removed device keeps its connection and hears everything
    const before = await f.owner.core.create(f.space.id, 'note', { text: 'before' });
    await waitFor(async () => (await f.editor.core.get(before.id)) !== undefined, 8000, 'editor reads before');

    const events: SecurityEvent[] = [];
    f.owner.spaces.on((e) => events.push(e));
    await f.owner.spaces.remove(f.space.id, f.editor.spaces.session()!.user);
    expect(events.some((e) => e.kind === 'key:rotated' && e.reason === 'member-removed' && e.epoch === 1)).toBe(true);
    expect((await f.owner.spaces.list())[0]!.currentEpoch).toBe(1);
    expect((await f.owner.spaces.members(f.space.id)).map((m) => m.role).sort()).toEqual(['owner', 'viewer', 'viewer']);

    const after: string[] = [];
    for (let i = 0; i < 20; i++) after.push((await f.owner.core.create(f.space.id, 'note', { text: `after ${i}` })).id);
    await waitFor(async () => (await f.viewer.core.query({ type: 'note' }).once()).length === 21, 10_000, 'remaining members read everything');
    await settle(f.g);

    let readable = 0;
    for (const id of after) if (await f.editor.core.get(id)) readable++;
    expect(readable).toBe(0); // SC-003
    expect(await f.editor.core.get(before.id)).toBeDefined(); // what it already had stays
    const parked = (await readPacketRecords(f.editor.storage)).filter((r) => r.status === 'parked' && r.reason === 'undecodable-codec');
    expect(parked.length).toBeGreaterThanOrEqual(20);
    await f.g.close();
  });

  it('rejects the removed member’s later packets, and ones beyond the cutoff dressed up with an old clock', async () => {
    const f = await buildFamily();
    const e = await Forger.of(f.editor);
    const early = await f.editor.core.create(f.space.id, 'note', { text: 'seen by the Owner' });
    await waitFor(async () => (await f.owner.core.get(early.id)) !== undefined, 8000, 'owner has it');
    await f.owner.spaces.remove(f.space.id, f.editor.spaces.session()!.user);
    await settle(f.g);

    const removal = (await f.owner.core.scanApplied(f.space.id, { typePrefix: '$sys.member' })).find((x) => (x.body.fields as { action?: string }).action === 'remove')!;
    const removedAt = Number(BigInt('0x' + removal.env.clock.slice(0, 12)));
    const backdated = await e.packet(f.space.id, e.body('late', { x: 1 }), { wall: removedAt - 1000 }); // clock before the removal, but a sequence number the Owner never saw
    const after = await e.packet(f.space.id, e.body('late', { x: 2 }), { seq: backdated.env.seq + 1, wall: removedAt + 1000 });
    for (const p of [backdated, after]) {
      const r = await f.owner.core.ingest(p.raw, 'memory:editor');
      expect(r.status).toBe('rejected');
      expect((r as { reason: string }).reason).toMatch(/beyond-cutoff|revoked/);
    }
    expect(await f.owner.spaces.rejectedCount(f.space.id)).toBeGreaterThanOrEqual(2);
    await f.g.close();
  });

  it('keeps at least one Owner: the last Owner cannot leave, be demoted, or be removed', async () => {
    const f = await buildFamily();
    const me = f.owner.spaces.session()!.user;
    await expect(f.owner.spaces.leave(f.space.id)).rejects.toBeInstanceOf(NotAuthorizedError);
    await expect(f.owner.spaces.setRole(f.space.id, me, 'editor')).rejects.toBeInstanceOf(NotAuthorizedError);
    await expect(f.owner.spaces.remove(f.space.id, me)).rejects.toBeInstanceOf(NotAuthorizedError);
    // with a second Owner it is allowed
    await f.owner.spaces.setRole(f.space.id, f.editor.spaces.session()!.user, 'owner');
    await waitFor(async () => (await f.editor.spaces.list())[0]?.myRole === 'owner', 8000, 'editor is an Owner');
    await f.owner.spaces.setRole(f.space.id, me, 'editor');
    expect((await f.owner.spaces.list())[0]!.myRole).toBe('editor');
    await f.g.close();
  });

  it('lets an Editor or Viewer leave: an Owner device rotates, and the leaver reads nothing new', async () => {
    const f = await buildFamily();
    f.g.link('owner', 'viewer');
    const events: SecurityEvent[] = [];
    f.owner.spaces.on((e) => events.push(e));
    await f.viewer.spaces.leave(f.space.id);
    await waitFor(() => events.some((e) => e.kind === 'key:rotated'), 8000, 'an Owner rotates for the leaver');
    const note = await f.owner.core.create(f.space.id, 'note', { text: 'after the viewer left' });
    await waitFor(async () => (await f.editor.core.get(note.id)) !== undefined, 8000, 'the others read it');
    await settle(f.g);
    expect(await f.viewer.core.get(note.id)).toBeUndefined();
    expect((await f.owner.spaces.members(f.space.id)).some((m) => m.role === 'viewer' && m.user === f.viewer.spaces.session()!.user)).toBe(false);
    await f.g.close();
  });

  it('refuses removal by anyone but an Owner, and of someone who is not a member', async () => {
    const f = await buildFamily();
    await expect(f.editor.spaces.remove(f.space.id, f.viewer.spaces.session()!.user)).rejects.toBeInstanceOf(NotAuthorizedError);
    await expect(f.owner.spaces.remove(f.space.id, 'nobody')).rejects.toBeInstanceOf(NotAuthorizedError);
    await expect(f.viewer.spaces.setRole(f.space.id, f.viewer.spaces.session()!.user, 'owner')).rejects.toBeInstanceOf(NotAuthorizedError);
    await f.g.close();
  });
});
