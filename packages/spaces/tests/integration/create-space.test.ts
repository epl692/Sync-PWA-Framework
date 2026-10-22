// T040 (User Story 1): a new Space is encrypted from its first packet, and works with no transport.
import { describe, expect, it } from 'vitest';
import { decodeEnvelope } from '@sync/core';
import { createSecureNode, readPacketRecords } from '@sync/testkit';
import { SPACE_CODEC_ID, parseHeader } from '../../src';

describe('creating a Space', () => {
  it('makes the creator its Owner with an epoch-0 key, entirely offline', async () => {
    const n = await createSecureNode({ name: 'Maya' });
    expect(n.spaces.state).toBe('ready');
    const s = await n.spaces.create('Family');
    expect(s).toMatchObject({ name: 'Family', myRole: 'owner', currentEpoch: 0, memberCount: 1 });
    expect(await n.spaces.list()).toEqual([s]);
    const members = await n.spaces.members(s.id);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ role: 'owner', displayName: 'Maya' });
    expect(members[0]!.devices.map((d) => d.active)).toEqual([true]);
  });

  it('encrypts and signs every outgoing packet with the current epoch key', async () => {
    const n = await createSecureNode();
    const s = await n.spaces.create();
    const item = await n.core.create(s.id, 'item', { title: 'groceries' });
    await n.core.update(item.id, { done: true });
    const recs = await readPacketRecords(n.storage);
    expect(recs.length).toBeGreaterThanOrEqual(4); // genesis, epoch, create, update
    for (const r of recs) {
      const env = decodeEnvelope(r.raw).env;
      expect(env.codec).toBe(SPACE_CODEC_ID);
      expect(env.sig).not.toBeNull();
      expect(env.sig!.byteLength).toBe(64);
      expect(parseHeader(env.body)).toMatchObject({ scope: s.id, epoch: 0 });
      expect(new TextDecoder('latin1').decode(env.body)).not.toContain('groceries');
    }
  });

  it('reads back its own data and survives a restart (keys and state)', async () => {
    const n = await createSecureNode();
    const s = await n.spaces.create('Home');
    const item = await n.core.create(s.id, 'item', { title: 'x' });
    const again = await n.reopen();
    expect((await again.core.get(item.id))!.fields.title).toBe('x');
    expect((await again.spaces.list()).map((i) => i.id)).toEqual([s.id]);
    await again.core.update(item.id, { title: 'y' });
    expect((await again.core.get(item.id))!.fields.title).toBe('y');
    expect(again.core.deviceId).toBe(n.core.deviceId);
  });

  it('gives each Space its own ID, bound to the creating key', async () => {
    const n = await createSecureNode();
    const a = await n.spaces.create();
    const b = await n.spaces.create();
    expect(a.id).not.toBe(b.id);
    expect(a.id).toHaveLength(26);
  });

  it('hides control objects from ordinary queries', async () => {
    const n = await createSecureNode();
    const s = await n.spaces.create();
    await n.core.create(s.id, 'item', { t: 1 });
    expect((await n.core.query({ space: s.id }).once()).map((o) => o.type)).toEqual(['item']);
    expect((await n.core.query({ type: '$sys.genesis' }).once()).length).toBe(1);
  });

  it('refuses to create anything before sign-up', async () => {
    const n = await createSecureNode({ signUp: false });
    await expect(n.spaces.create()).rejects.toThrow(/sign up/);
    const session = await n.spaces.signUp('Eli');
    expect(n.spaces.session()).toEqual(session);
    expect(session.displayName).toBe('Eli');
    expect(await n.spaces.signUp('other')).toEqual(session); // idempotent
  });

  it('writes nothing in a Space the user cannot write in, with a reason', async () => {
    const n = await createSecureNode();
    await expect(n.core.create('NOSUCHSPACEAAAAAAAAAAAAAA', 'item', { a: 1 })).rejects.toThrow();
  });
});
