// T057 (spec Edge Case): two people accept the same single-use invite at once.
import { describe, expect, it } from 'vitest';
import { JoinDeniedError, type SecurityEvent } from '@sync/spaces';
import { createSecureGroup, waitFor } from '@sync/testkit';
import { Forger } from '../../../spaces/tests/forger';
import { SYS } from '../../../spaces/src/authority/types';
import { b64urlEncode } from '@sync/core';
import { Keystore, deriveShared, signBytes } from '@sync/spaces';
import { issueGenesis } from '../../src/binding';
import { createInviteProvider } from '../../src';

const provider = () => createInviteProvider({ baseUrl: 'https://app.test/', joinTimeoutMs: 8000 });

describe('a single-use invite accepted twice at once', () => {
  it('admits exactly one of two simultaneous joiners', async () => {
    const g = await createSecureGroup(['owner', 'a', 'b'], {
      provider,
      approveJoin: () => true,
      rotationGraceMs: 20,
    });
    g.link('owner', 'a');
    g.link('owner', 'b');
    const owner = g.node('owner');
    const space = await owner.spaces.create();
    const art = await owner.spaces.invite(space.id, {
      role: 'editor',
      expiresAt: g.clock.now() + 3_600_000,
      maxUses: 1,
      approval: 'auto',
    });
    const results = await Promise.allSettled([
      g.node('a').spaces.accept(art.url),
      g.node('b').spaces.accept(art.url),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const denied = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(denied).toHaveLength(1);
    expect(denied[0]!.reason).toBeInstanceOf(JoinDeniedError);
    expect((denied[0]!.reason as JoinDeniedError).reason).toBe('used-up');
    expect((await owner.spaces.members(space.id)).filter((m) => m.role === 'editor')).toHaveLength(1);
    await g.close();
  });

  it('when two Owner devices both admitted someone offline, the later admission is inert and the Space key is rotated', async () => {
    const g = await createSecureGroup(['owner', 'a', 'owner2', 'surplus'], {
      provider,
      approveJoin: () => true,
      rotationGraceMs: 20,
    });
    g.link('owner', 'a');
    g.link('owner', 'owner2');
    const owner = g.node('owner');
    const space = await owner.spaces.create();
    const exp = g.clock.now() + 3_600_000;
    await g
      .node('owner2')
      .spaces.accept(
        (await owner.spaces.invite(space.id, { role: 'owner', expiresAt: exp, maxUses: 1, approval: 'auto' }))
          .url,
      );
    await waitFor(
      async () => (await g.node('owner2').spaces.list()).length === 1,
      10_000,
      'second Owner joined',
    );
    const art = await owner.spaces.invite(space.id, {
      role: 'editor',
      expiresAt: exp,
      maxUses: 1,
      approval: 'auto',
    });
    await g.node('a').spaces.accept(art.url); // the first joiner uses the invite up
    await waitFor(
      async () => (await g.node('owner2').spaces.members(space.id)).length === 3,
      10_000,
      'second Owner knows the joiner',
    );
    const events: SecurityEvent[] = [];
    owner.spaces.on((e) => events.push(e));

    // the second Owner device, offline and unaware that the invite was used up, admitted someone else: write what it would have written
    const surplus = g.node('surplus');
    const sKs = await Keystore.open(surplus.keyDb);
    const sd = sKs.requireDevice();
    const local = {
      deviceId: sd.deviceId,
      signPub: sd.signPub,
      agreePub: sd.agreePub,
      sign: (b: Uint8Array) => signBytes(sd.signPriv, b),
      deriveShared: (p: Uint8Array) => deriveShared(sd.agreePriv, p),
    };
    const binding = await issueGenesis(local as never);
    const o2 = await Forger.of(g.node('owner2'));
    const deviceEvent = await o2.packet(
      space.id,
      o2.body(SYS.device, {
        user: sd.deviceId,
        device: sd.deviceId,
        signPub: b64urlEncode(sd.signPub),
        agreePub: b64urlEncode(sd.agreePub),
        binding: { kind: binding.kind, proof: b64urlEncode(binding.proof) },
      }),
    );
    const memberEvent = await o2.packet(
      space.id,
      o2.body(SYS.member, { action: 'add', user: sd.deviceId, role: 'editor', inviteId: art.inviteId }),
      { seq: deviceEvent.env.seq + 1 },
    );
    for (const p of [deviceEvent, memberEvent])
      expect((await owner.core.ingest(p.raw, 'memory:owner2')).status).toBe('applied');

    expect((await owner.spaces.members(space.id)).map((m) => m.user)).not.toContain(sd.deviceId); // inert: not a member
    await waitFor(
      () => events.some((e) => e.kind === 'key:rotated' && e.reason === 'invite-surplus'),
      8000,
      'the Space key is rotated',
    );
    expect((await owner.spaces.list())[0]!.currentEpoch).toBe(1);

    // the first joiner is still in and reads what is written under the new key
    const after = await owner.core.create(space.id, 'note', { text: 'after rotation' });
    await waitFor(
      async () => (await g.node('a').core.get(after.id)) !== undefined,
      10_000,
      'the legitimate joiner follows the rotation',
    );
    await g.close();
  });
});
