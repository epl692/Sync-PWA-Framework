// T086 (quickstart S11, plan "Performance Goals"): measured, with generous bounds so slow CI machines do not flake.
// Numbers are printed so they can be compared with the plan's targets (which assume a 4x slower phone).
import { describe, expect, it } from 'vitest';
import { b64urlEncode } from '@sync/core';
import { createSecureNode } from '@sync/testkit';
import { SYS } from '../../src/authority/types';
import { Keystore } from '../../src';
import { generateSignKeyPair, signBytes, verifySignature } from '../../src/crypto/suite';
import { Forger } from '../forger';
import { World, makeDevice } from '../packets';
import { importAesKey } from '../../src/crypto/suite';

const SLOWDOWN = 4; // the plan's phone profile
const ms = () => performance.now();

describe('performance', () => {
  it('verifies signatures fast enough (target: 2,000 packets/s on the phone profile)', async () => {
    const k = await generateSignKeyPair();
    const msg = new Uint8Array(400).fill(7);
    const sig = await signBytes(k.privateKey, msg);
    const N = 6000;
    const t0 = ms();
    // verified in groups of 64 at a time, as a batch of incoming packets is (see the validator's `prepare`)
    for (let i = 0; i < N; i += 64) {
      const ok = await Promise.all(Array.from({ length: Math.min(64, N - i) }, () => verifySignature(k.publicRaw, sig, msg)));
      if (ok.some((x) => !x)) throw new Error('bad');
    }
    const perSec = N / ((ms() - t0) / 1000);
    console.log(`signature verification: ${Math.round(perSec)}/s here, about ${Math.round(perSec / SLOWDOWN)}/s on the phone profile`);
    expect(perSec / SLOWDOWN).toBeGreaterThan(2000);
  });

  it('ingests encrypted, signed packets (decrypt + verify + validate + store) at a useful rate', async () => {
    const world = new World();
    const A = await makeDevice('A');
    const B = await makeDevice('B');
    await world.init(A);
    const binding = { kind: 'stub-token/1', proof: b64urlEncode(new TextEncoder().encode(`ok|${A.user}|${A.id}`)) };
    const judge = await createSecureNode({ signUp: false });
    const ks = await Keystore.open(judge.keyDb);
    await ks.putEpochKey(world.space, 0, world.raw.get(world.space)!, 'grant');
    const ctl = async (dev: typeof A, type: keyof import('../../src/authority/types').ControlFields, fields: never, t: number) => (await world.control(dev, type, fields, t)).raw;
    const pub = (d: typeof A) => ({ signPub: b64urlEncode(d.signPub), agreePub: b64urlEncode(d.agreePub) });
    const bindB = { kind: 'stub-token/1', proof: b64urlEncode(new TextEncoder().encode(`ok|${B.user}|${B.id}`)) };
    const setup = [
      await ctl(A, SYS.genesis, { owner: { user: A.id, device: A.id, ...pub(A), binding }, nonce: b64urlEncode(world.nonce) } as never, 1),
      await ctl(A, SYS.device, { user: B.user, device: B.id, ...pub(B), binding: bindB } as never, 2),
      await ctl(A, SYS.member, { action: 'add', user: B.user, role: 'editor' } as never, 3),
    ];
    for (const r of setup) await judge.core.ingest(r, 'setup');
    await judge.spaces.idle();

    const N = 2000;
    const packets: Uint8Array[] = [];
    for (let i = 0; i < N; i++) packets.push((await world.packet(B, world.body('note', { i, text: 'x'.repeat(100) }, `o${i}`), 10 + i)).raw);
    const t0 = ms();
    const results = await judge.core.ingestBatch(packets, 'bench');
    const sec = (ms() - t0) / 1000;
    expect(results.every((r) => r.status === 'applied')).toBe(true);
    console.log(`ingest of ${N} encrypted+signed packets: ${Math.round(N / sec)}/s here, about ${Math.round(N / sec / SLOWDOWN)}/s on the phone profile`);
    expect(N / sec / SLOWDOWN).toBeGreaterThan(100); // a catch-up of 10,000 packets in under two minutes even on the phone profile
    void importAesKey;
  });

  it('rotates the Space key for 100 devices well inside the target (2 s on the phone profile)', async () => {
    const owner = await createSecureNode({ name: 'owner' });
    const second = await createSecureNode({ name: 'second' });
    const g = { clock: owner.clock };
    void g;
    const space = await owner.spaces.create('Big');
    // a second Owner device (never connected) writes the 100 member records; they are handed to the first Owner
    const { MemoryNetwork } = await import('@sync/testkit');
    const net = new MemoryNetwork();
    owner.core.addTransport(net.transport('owner'));
    second.core.addTransport(net.transport('second'));
    net.link('owner', 'second');
    const art = await owner.spaces.invite(space.id, { role: 'owner', expiresAt: owner.clock.now() + 3_600_000, maxUses: 1, approval: 'auto' });
    await second.spaces.accept(art.url);
    const { waitFor } = await import('@sync/testkit');
    await waitFor(async () => (await second.spaces.list()).length === 1, 10_000, 'second Owner');
    net.sever('owner', 'second');
    const o = await Forger.of(second);
    const total = 100;
    const members: string[] = [];
    for (let i = 0; i < total; i++) {
      const d = await makeDevice(`m${i}`);
      members.push(d.user);
      const proof = b64urlEncode(new TextEncoder().encode(`ok|${d.user}|${d.id}`));
      const dev = await o.packet(space.id, o.body(SYS.device, { user: d.user, device: d.id, signPub: b64urlEncode(d.signPub), agreePub: b64urlEncode(d.agreePub), binding: { kind: 'stub-token/1', proof } }), { seq: (await o.nextSeq(space.id)) + i * 2 });
      expect((await owner.core.ingest(dev.raw, 'bench')).status).toBe('applied');
      const mem = await o.packet(space.id, o.body(SYS.member, { action: 'add', user: d.user, role: 'editor' }), { seq: (await o.nextSeq(space.id)) + i * 2 + 1 });
      expect((await owner.core.ingest(mem.raw, 'bench')).status).toBe('applied');
    }
    expect((await owner.spaces.members(space.id)).length).toBe(total + 2);
    const t0 = ms();
    await owner.spaces.remove(space.id, members[0]!); // rotates for 100 other devices
    const took = ms() - t0;
    console.log(`rotation for ${total + 1} devices: ${Math.round(took)} ms here, about ${Math.round(took * SLOWDOWN)} ms on the phone profile`);
    expect((await owner.spaces.list())[0]!.currentEpoch).toBe(1);
    expect(took * SLOWDOWN).toBeLessThan(2000);
  }, 120_000);
});
