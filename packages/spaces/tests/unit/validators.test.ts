// T031: the packet validator against contracts/crypto-envelope.md ("Verification order") and authority-rules.md.
import { describe, expect, it } from 'vitest';
import { b64urlEncode, decodeEnvelope, encodeEnvelope, newId, type DataPacketEnvelope, type PacketValidator, type ValidationResult } from '@sync/core';
import { SYS } from '../../src/authority/types';
import { SPACE_CODEC_ID } from '../../src/codec/spaceCodec';
import { createSpacesValidator } from '../../src/validators/spacesValidator';
import { basicWorld, makeDevice, pub, T0 } from '../packets';

async function setup() {
  const w = await basicWorld();
  const reported: string[] = [];
  const bindingCalls: unknown[] = [];
  const validator: PacketValidator = createSpacesValidator({
    authorities: { ensure: async () => w.auth },
    verifyBinding: async (...args) => (bindingCalls.push(args), args[2].kind === 'test'),
    report: (r) => reported.push(r.code),
  });
  const run = async (p: { env: DataPacketEnvelope; raw: Uint8Array }, opts: { phase?: 'send' | 'apply'; source?: string; decode?: boolean } = {}): Promise<ValidationResult> => {
    let body;
    if (opts.decode !== false) {
      const d = await w.world.codec.decode(p.env.body, { space: p.env.space, author: p.env.author, envelope: { v: p.env.v, id: p.env.id, seq: p.env.seq, clock: p.env.clock, codec: p.env.codec } });
      body = d.ok ? d.body : undefined;
    }
    return validator.validate(opts.phase ?? 'apply', p.env, body, { now: () => T0, raw: p.raw, source: opts.source ?? 'peer' }) as Promise<ValidationResult>;
  };
  return { ...w, validator, reported, bindingCalls, run };
}

const item = (w: Awaited<ReturnType<typeof setup>>) => w.world.body('item', { title: 'x' });

describe('signature', () => {
  it('accepts a correctly signed packet from an Editor', async () => {
    const s = await setup();
    expect(await s.run(await s.world.packet(s.B, item(s), 10))).toEqual({ verdict: 'accept' });
  });

  it('rejects an unsigned packet, a flipped signature, and a signature by another device', async () => {
    const s = await setup();
    expect(await s.run(await s.world.packet(s.B, item(s), 10, { sign: false }))).toMatchObject({ verdict: 'reject', reason: expect.stringContaining('bad-signature') });
    const flipped = await s.world.packet(s.B, item(s), 11, { tamper: (e) => ({ ...e, sig: e.sig!.map((b, i) => (i === 0 ? b ^ 1 : b)) }) });
    expect(await s.run(flipped)).toMatchObject({ verdict: 'reject' });
    const forged = await s.world.packet(s.B, item(s), 12, { signWith: s.A }); // Owner's key, Editor's name
    expect(await s.run(forged)).toMatchObject({ verdict: 'reject', reason: expect.stringContaining('bad-signature') });
  });

  it('rejects a packet whose envelope was changed after signing (clock, space, body)', async () => {
    const s = await setup();
    const base = await s.world.packet(s.B, item(s), 10);
    for (const change of [(e: DataPacketEnvelope) => ({ ...e, clock: e.clock.replace(/-0*\d{1,3}-/, '-0777-') }), (e: DataPacketEnvelope) => ({ ...e, body: e.body.map((b, i) => (i === 40 ? b ^ 1 : b)) })]) {
      const t = { ...base.env, ...change(base.env) };
      const raw = encodeEnvelope(t);
      expect(await s.run({ env: decodeEnvelope(raw).env, raw }, { decode: false })).toMatchObject({ verdict: 'reject', reason: expect.stringContaining('bad-signature') });
    }
  });

  it('keeps unknown extra envelope fields under the signature (verifies over the received bytes)', async () => {
    const s = await setup();
    const p = await s.world.packet(s.B, item(s), 10);
    const withExtra = JSON.parse(new TextDecoder().decode(p.raw));
    withExtra.futureField = 'x';
    const raw = new TextEncoder().encode(JSON.stringify(withExtra));
    expect(await s.run({ env: decodeEnvelope(raw).env, raw }, { decode: false })).toMatchObject({ verdict: 'reject' }); // signature covered the original bytes
  });

  it('defers a signature of an unknown length (a future suite) and an unknown author', async () => {
    const s = await setup();
    const odd = await s.world.packet(s.B, item(s), 10, { tamper: (e) => ({ ...e, sig: new Uint8Array(65) }) });
    expect(await s.run(odd)).toEqual({ verdict: 'defer', reason: 'unknown-signature-suite' });
    const stranger = await makeDevice('X');
    expect(await s.run(await s.world.packet(stranger, item(s), 10))).toEqual({ verdict: 'defer', reason: 'unknown-device' });
  });

  it('does not re-verify a packet it already verified (cache by ID and signature)', async () => {
    const s = await setup();
    const p = await s.world.packet(s.B, item(s), 10);
    expect((await s.run(p)).verdict).toBe('accept');
    expect((await s.run(p)).verdict).toBe('accept');
  });

  it('skips verification for the local device and in the send phase', async () => {
    const s = await setup();
    const unsigned = await s.world.packet(s.B, item(s), 10, { sign: false });
    expect(await s.run(unsigned, { source: 'local' })).toEqual({ verdict: 'accept' });
    expect(await s.run(unsigned, { phase: 'send', source: undefined })).toEqual({ verdict: 'accept' });
  });
});

describe('standing and role', () => {
  it('rejects a Viewer writing data; accepts Owner and Editor', async () => {
    const s = await setup();
    expect(await s.run(await s.world.packet(s.C, item(s), 10))).toMatchObject({ verdict: 'reject', reason: 'role' });
    expect((await s.run(await s.world.packet(s.A, item(s), 11))).verdict).toBe('accept');
    expect((await s.run(await s.world.packet(s.B, item(s), 12))).verdict).toBe('accept');
    expect(s.reported).toEqual(['role']);
  });

  it('defers a device that is known but whose user is not a member (yet)', async () => {
    const s = await setup();
    const d = await makeDevice('D');
    s.auth.add({ id: `${s.A.id}:90`, type: SYS.device, clock: s.world.clock(s.A, 20), author: s.A.id, seq: 90, fields: { user: d.id, device: d.id, ...pub(d), binding: s.binding } });
    expect(await s.run(await s.world.packet(d, item(s), 30))).toEqual({ verdict: 'defer', reason: 'not-member' });
  });

  it('rejects packets from a removed member beyond the cutoff or after the removal, but accepts those within it', async () => {
    const s = await setup();
    const early = await s.world.packet(s.B, item(s), 10); // seq 1
    const late1 = await s.world.packet(s.B, item(s), 11); // seq 2
    const rm = await s.world.control(s.A, SYS.member, { action: 'remove', user: s.B.id, cutoff: { [s.B.id]: 1 } }, 50);
    s.auth.add(rm.event);
    expect((await s.run(early)).verdict).toBe('accept');
    expect(await s.run(late1)).toMatchObject({ verdict: 'reject', reason: 'beyond-cutoff' });
    const after = await s.world.packet(s.B, item(s), 60, { seq: 1 });
    expect(await s.run(after)).toMatchObject({ verdict: 'reject', reason: 'revoked' });
  });
});

describe('scope and override shares', () => {
  const SHARE = 'SHAREAAAAAAAAAAAAAAAAAAAAA';

  it('rejects a Viewer writing under a share scope without reading the body', async () => {
    const s = await setup();
    await s.world.addKey(SHARE);
    s.world.shareOf.set('o1', SHARE);
    const p = await s.world.packet(s.C, s.world.body('item', { a: 1 }, 'o1'), 10);
    expect(await s.run(p, { decode: false })).toMatchObject({ verdict: 'reject', reason: expect.stringContaining('role') });
  });

  it('accepts an undecodable packet of an Editor (envelope checks only), and a share member write', async () => {
    const s = await setup();
    await s.world.addKey(SHARE);
    s.world.shareOf.set('o1', SHARE);
    const p = await s.world.packet(s.B, s.world.body('item', { a: 1 }, 'o1'), 10);
    expect((await s.run(p, { decode: false })).verdict).toBe('accept');
    const share = await s.world.control(s.B, SYS.share, { shareId: SHARE, obj: 'o1', members: [{ user: s.B.id, role: 'owner' }] }, 20);
    s.auth.add(share.event);
    const after = await s.world.packet(s.B, s.world.body('item', { a: 2 }, 'o1'), 30);
    expect((await s.run(after)).verdict).toBe('accept');
  });

  it('after a share exists, a Space-scope packet for its object is rejected, and a share-scope packet from a non-member too', async () => {
    const s = await setup();
    await s.world.addKey(SHARE);
    s.auth.add((await s.world.control(s.B, SYS.share, { shareId: SHARE, obj: 'o1', members: [{ user: s.B.id, role: 'owner' }] }, 20)).event);
    const spaceScope = await s.world.packet(s.A, s.world.body('item', { a: 1 }, 'o2'), 30); // some other object, fine
    expect((await s.run(spaceScope)).verdict).toBe('accept');
    s.world.shareOf.clear();
    const smuggled = await s.world.packet(s.A, s.world.body('item', { a: 1 }, 'o1'), 31); // Owner writes o1 with the Space key
    expect(await s.run(smuggled)).toMatchObject({ verdict: 'reject', reason: expect.stringContaining('wrong-scope') });
    s.world.shareOf.set('o1', SHARE);
    const outsider = await s.world.packet(s.A, s.world.body('item', { a: 1 }, 'o1'), 32); // has the share key in this test, but is not a member
    expect(await s.run(outsider)).toMatchObject({ verdict: 'reject', reason: expect.stringContaining('role') });
  });

  it('defers a share-scope packet for a share it does not know yet', async () => {
    const s = await setup();
    await s.world.addKey(SHARE);
    s.world.shareOf.set('o9', SHARE);
    const p = await s.world.packet(s.B, s.world.body('item', { a: 1 }, 'o9'), 10);
    expect(await s.run(p)).toEqual({ verdict: 'defer', reason: 'unknown-share' });
  });
});

describe('control events', () => {
  it('rejects update and delete of a $sys object (immutable)', async () => {
    const s = await setup();
    for (const op of ['update', 'delete'] as const) {
      const p = await s.world.packet(s.A, { ...s.world.body(SYS.inviteRevoke, { inviteId: 'x' }), op }, 10);
      expect(await s.run(p)).toMatchObject({ verdict: 'reject', reason: 'immutable-control' });
    }
  });

  it('rejects malformed fields', async () => {
    const s = await setup();
    const p = await s.world.packet(s.A, s.world.body(SYS.member, { action: 'add', user: 'x', role: 'god' }), 10);
    expect(await s.run(p)).toMatchObject({ verdict: 'reject', reason: expect.stringContaining('malformed') });
  });

  it('only an Owner changes members, invites and epochs; leaving yourself is allowed', async () => {
    const s = await setup();
    const asEditor = await s.world.packet(s.B, s.world.body(SYS.member, { action: 'add', user: 'zed', role: 'viewer' }), 10);
    expect(await s.run(asEditor)).toMatchObject({ verdict: 'reject', reason: expect.stringContaining('role') });
    const leave = await s.world.packet(s.B, s.world.body(SYS.member, { action: 'remove', user: s.B.id, cutoff: { [s.B.id]: 4 } }), 11);
    expect((await s.run(leave)).verdict).toBe('accept');
    const inv = await s.world.packet(s.B, s.world.body(SYS.invite, { inviteId: 'i', role: 'viewer', expiresAt: T0 + 1e6, maxUses: 1, secretHash: 'aGFzaA', approval: 'required' }), 12);
    expect((await s.run(inv)).verdict).toBe('reject');
    const epoch = await s.world.packet(s.B, s.world.body(SYS.epoch, { scope: s.world.space, epoch: 1, keyId: 'aaaaaaaaaaaaaaaa' }), 13);
    expect((await s.run(epoch)).verdict).toBe('reject');
    const ownerEpoch = await s.world.packet(s.A, s.world.body(SYS.epoch, { scope: s.world.space, epoch: 1, keyId: 'aaaaaaaaaaaaaaaa' }), 14);
    expect((await s.run(ownerEpoch)).verdict).toBe('accept');
  });

  it('a member may add devices for their own user only (a Viewer too); the binding is checked by the provider', async () => {
    const s = await setup();
    const d = await makeDevice('C2', s.C.id);
    const mine = await s.world.packet(s.C, s.world.body(SYS.device, { user: s.C.id, device: d.id, ...pub(d), binding: s.binding }), 10);
    expect((await s.run(mine)).verdict).toBe('accept');
    expect(s.bindingCalls).toHaveLength(1);
    const other = await s.world.packet(s.C, s.world.body(SYS.device, { user: s.B.id, device: d.id, ...pub(d), binding: s.binding }), 11);
    expect(await s.run(other)).toMatchObject({ verdict: 'reject', reason: expect.stringContaining('role') });
    const badBinding = await s.world.packet(s.C, s.world.body(SYS.device, { user: s.C.id, device: d.id, ...pub(d), binding: { kind: 'forged', proof: '' } }), 12);
    expect(await s.run(badBinding)).toMatchObject({ verdict: 'reject', reason: 'bad-binding' });
    const wrongId = await s.world.packet(s.C, s.world.body(SYS.device, { user: s.C.id, device: newId(), ...pub(d), binding: s.binding }), 13);
    expect(await s.run(wrongId)).toMatchObject({ verdict: 'reject', reason: 'device-id-mismatch' });
  });

  it('a key grant: Owners to anyone, anyone to their own devices, nobody else', async () => {
    const s = await setup();
    const grant = (to: string) => ({ to, scope: s.world.space, eph: b64urlEncode(new Uint8Array(32)), items: [{ epoch: 1, keyId: 'aaaaaaaaaaaaaaaa', nonce: b64urlEncode(new Uint8Array(12)), wrapped: b64urlEncode(new Uint8Array(48)) }] });
    expect((await s.run(await s.world.packet(s.A, s.world.body(SYS.keygrant, grant(s.B.id)), 10))).verdict).toBe('accept');
    expect((await s.run(await s.world.packet(s.B, s.world.body(SYS.keygrant, grant(s.C.id)), 11))).verdict).toBe('reject');
    expect((await s.run(await s.world.packet(s.B, s.world.body(SYS.keygrant, grant(s.B.id)), 12))).verdict).toBe('accept');
  });

  it('genesis: the Space ID must derive from the owner key; a mismatch is rejected', async () => {
    const world = (await basicWorld()).world;
    const fresh = await makeDevice('Z');
    const w2 = world; // reuse codec helpers, but a new Authority with no genesis
    const { Authority } = await import('../../src/authority/authority');
    const auth = new Authority(world.space);
    const validator = createSpacesValidator({ authorities: { ensure: async () => auth }, verifyBinding: async () => true });
    const good = await world.control(fresh, SYS.genesis, { owner: { user: fresh.id, device: fresh.id, ...pub(fresh), binding: { kind: 'test', proof: '' } }, nonce: b64urlEncode(world.nonce) }, 1);
    const run = async (p: typeof good) => {
      const d = await world.codec.decode(p.env.body, { space: p.env.space, author: p.env.author, envelope: { v: 1, id: p.env.id, seq: p.env.seq, clock: p.env.clock, codec: SPACE_CODEC_ID } });
      return validator.validate('apply', p.env, d.ok ? d.body : undefined, { now: () => T0, raw: p.raw, source: 'peer' }) as Promise<ValidationResult>;
    };
    expect(await run(good)).toMatchObject({ verdict: 'reject', reason: expect.stringContaining('bad-genesis') }); // world.space came from device A
    void w2;
  });
});

describe('codec and format', () => {
  it('defers a packet in a foreign codec and rejects a header-less body', async () => {
    const s = await setup();
    const p = await s.world.packet(s.B, item(s), 10, { tamper: (e) => ({ ...e, codec: 'test-plaintext/1' }) });
    expect(await s.run(p, { decode: false })).toEqual({ verdict: 'defer', reason: 'foreign-codec' });
    const noHeader = await s.world.packet(s.B, item(s), 11, { tamper: (e) => ({ ...e, body: new Uint8Array([1, 2, 3]) }) });
    expect(await s.run(noHeader, { decode: false })).toMatchObject({ verdict: 'reject', reason: expect.stringContaining('malformed') });
    const future = await s.world.packet(s.B, item(s), 12, { tamper: (e) => ({ ...e, body: new Uint8Array([9, ...e.body.slice(1)]) }) });
    expect(await s.run(future, { decode: false })).toEqual({ verdict: 'defer', reason: 'unknown-format' });
  });
});

describe('replay of the genesis packet (rebuild)', () => {
  it('accepts the Space’s own genesis packet when the authority already folded it', async () => {
    const s = await setup();
    const g = await s.world.control(s.A, SYS.genesis, { owner: { user: s.A.id, device: s.A.id, ...pub(s.A), binding: s.binding }, nonce: b64urlEncode(s.world.nonce) }, 1);
    // basicWorld folded a different genesis event for this Space; the same packet ID is what the authority knows
    s.auth.load([]);
    s.auth.add(g.event);
    expect(await s.run(g)).toEqual({ verdict: 'accept' });
  });
});
