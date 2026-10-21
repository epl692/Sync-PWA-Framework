// T048/T049 (User Story 2, SC-001): named attacks against a real Space. None is applied, none is relayed.
import { describe, expect, it } from 'vitest';
import { decodeEnvelope, type CoreEvent } from '@sync/core';
import { readPacketRecords, waitFor } from '@sync/testkit';
import { SYS } from '../../src/authority/types';
import { SPACE_CODEC_ID, parseHeader } from '../../src/codec/spaceCodec';
import { Forger } from '../forger';
import { buildFamily, settle, type Family } from '../family';

async function inject(f: Family, raw: Uint8Array) {
  return f.owner.core.ingest(raw, 'memory:attacker');
}

const visible = async (f: Family, node: Family['owner'], type: string) => (await node.core.query({ space: f.space.id, type }).once()).length;
const holds = async (node: Family['owner'], id: string) => (await readPacketRecords(node.storage)).some((r) => r.id === id && r.status === 'applied');

/** Never applied on any peer. A rejected packet is also never forwarded; a deferred one (unknown author) may be, unapplied. */
async function expectNowhere(f: Family, id: string, type: string, opts: { forwarded?: boolean } = {}) {
  await settle(f.g);
  for (const n of [f.owner, f.editor, f.viewer, f.obs]) {
    expect(await holds(n, id), `${n.name} applied ${id}`).toBe(false);
    expect(await visible(f, n, type), `${n.name} shows ${type}`).toBe(0);
  }
  if (!opts.forwarded) {
    // the observer, who only hears from the Owner, was never even sent it
    expect((await readPacketRecords(f.obs.storage)).some((r) => r.id === id)).toBe(false);
  }
}

describe('peers enforce roles (User Story 2)', () => {
  it('rejects a Viewer who writes data with a valid signature and a valid ciphertext', async () => {
    const f = await buildFamily();
    const v = await Forger.of(f.viewer);
    const p = await v.packet(f.space.id, v.body('forged-by-viewer', { x: 1 }));
    const events: CoreEvent[] = [];
    f.owner.core.on((e) => events.push(e));
    const r = await inject(f, p.raw);
    expect(r.status).toBe('rejected');
    expect(r).toMatchObject({ reason: expect.stringContaining('role') });
    await expectNowhere(f, p.env.id, 'forged-by-viewer');
    expect(await f.owner.spaces.rejectedCount(f.space.id)).toBeGreaterThanOrEqual(1);
    await f.g.close();
  });

  it('rejects a flipped signature, a missing signature, and a signature made with another member’s key', async () => {
    const f = await buildFamily();
    const e = await Forger.of(f.editor);
    const o = await Forger.of(f.owner);
    const flipped = await e.packet(f.space.id, e.body('t-flip', {}), { tamper: (x) => ({ ...x, sig: x.sig!.map((b, i) => (i === 3 ? b ^ 1 : b)) }) });
    const unsigned = await e.packet(f.space.id, e.body('t-unsigned', {}), { sign: false });
    const borrowed = await e.packet(f.space.id, e.body('t-borrowed', {}), { signWith: o });
    for (const [p, t] of [[flipped, 't-flip'], [unsigned, 't-unsigned'], [borrowed, 't-borrowed']] as const) {
      expect((await inject(f, p.raw)).status).toBe('rejected');
      await expectNowhere(f, p.env.id, t);
    }
    await f.g.close();
  });

  it('never applies a packet from an outsider who holds the Space key (an unknown device is parked, not applied)', async () => {
    const f = await buildFamily({ extra: ['mallory'] });
    // mallory is a real device that learned the Space key somehow, but nobody ever added her
    const m = await Forger.of(f.g.node('mallory'));
    const ownerKs = await Forger.of(f.owner);
    const raw = await ownerKs.ks.rawKey(f.space.id, (await ownerKs.ks.epochs(f.space.id))[0]!.keyId);
    await m.ks.putEpochKey(f.space.id, 0, raw!, 'self');
    const p = await m.packet(f.space.id, m.body('t-outsider', { x: 1 }));
    const r = await inject(f, p.raw);
    expect(['parked', 'rejected']).toContain(r.status);
    await expectNowhere(f, p.env.id, 't-outsider', { forwarded: true });
    await f.g.close();
  });

  it('rejects a changed envelope (clock), a changed header (epoch), and a flipped ciphertext byte', async () => {
    const f = await buildFamily();
    const e = await Forger.of(f.editor);
    const cases: Array<[string, (x: import('@sync/core').DataPacketEnvelope) => import('@sync/core').DataPacketEnvelope]> = [
      ['t-clock', (x) => ({ ...x, clock: x.clock.replace(/-(\d{4})-/, (_m, c) => `-${String((Number(c) + 1) % 10000).padStart(4, '0')}-`) })],
      ['t-epoch', (x) => ({ ...x, body: x.body.map((b, i) => (i === 20 ? b ^ 1 : b)) })],
      ['t-ct', (x) => ({ ...x, body: x.body.map((b, i) => (i === x.body.length - 1 ? b ^ 1 : b)) })],
    ];
    for (const [type, tamper] of cases) {
      const p = await e.packet(f.space.id, e.body(type, { x: 1 }), { tamper });
      expect((await inject(f, p.raw)).status, type).toBe('rejected');
      await expectNowhere(f, p.env.id, type);
    }
    await f.g.close();
  });

  it('rejects a ciphertext moved into another envelope (it is bound to its envelope)', async () => {
    const f = await buildFamily();
    const e = await Forger.of(f.editor);
    const good = await e.packet(f.space.id, e.body('t-good', { x: 1 }));
    const seq = (await e.nextSeq(f.space.id)) + 5;
    const moved = await e.packet(f.space.id, e.body('t-moved', {}), { seq, tamper: (x) => ({ ...x, body: good.env.body }) });
    const r = await inject(f, moved.raw);
    expect(r.status).toBe('rejected');
    await expectNowhere(f, moved.env.id, 't-moved');
    await f.g.close();
  });

  it('applies a valid packet once: a replay changes nothing', async () => {
    const f = await buildFamily();
    const e = await Forger.of(f.editor);
    const p = await e.packet(f.space.id, e.body('t-ok', { n: 1 }));
    expect((await inject(f, p.raw)).status).toBe('applied');
    expect((await inject(f, p.raw)).status).toBe('duplicate');
    const hash = await f.owner.core.stateHash(f.space.id);
    for (let i = 0; i < 5; i++) await inject(f, p.raw);
    expect(await f.owner.core.stateHash(f.space.id)).toBe(hash);
    await waitFor(async () => (await visible(f, f.obs, 't-ok')) === 1, 8000, 'valid packet is relayed');
    await f.g.close();
  });

  it('rejects an Editor who tries to make themselves Owner or add members (control events need an Owner)', async () => {
    const f = await buildFamily();
    const e = await Forger.of(f.editor);
    const me = f.editor.spaces.session()!.user;
    const promote = await e.packet(f.space.id, e.body(SYS.member, { action: 'role', user: me, role: 'owner' }));
    const addSelf = await e.packet(f.space.id, e.body(SYS.member, { action: 'add', user: 'friend', role: 'editor' }));
    for (const p of [promote, addSelf]) expect((await inject(f, p.raw)).status).toBe('rejected');
    expect((await f.owner.spaces.members(f.space.id)).find((m) => m.user === me)!.role).toBe('editor');
    await f.g.close();
  });

  it('rejects an update or delete of a control object (they are immutable)', async () => {
    const f = await buildFamily();
    const o = await Forger.of(f.owner);
    const target = (await f.owner.core.query({ type: SYS.member }).once())[0]!;
    for (const op of ['update', 'delete'] as const) {
      const fields = op === 'delete' ? {} : { action: 'role', user: 'x', role: 'viewer' };
      const p = await o.packet(f.space.id, { ...o.body(SYS.member, fields, target.id), op });
      expect(await inject(f, p.raw)).toMatchObject({ status: 'rejected', reason: expect.stringContaining('immutable') });
    }
    await f.g.close();
  });

  it('refuses a packet in a foreign codec (the plaintext codec is not accepted)', async () => {
    const f = await buildFamily();
    const e = await Forger.of(f.editor);
    const p = await e.packet(f.space.id, e.body('t-foreign', { x: 1 }), { tamper: (x) => ({ ...x, codec: 'test-plaintext/1' }), sign: true });
    const r = await inject(f, p.raw);
    expect(r.status).not.toBe('applied');
    await expectNowhere(f, p.env.id, 't-foreign', { forwarded: true });
    await f.g.close();
  });

  it('uses the SPACE codec and a header scope that names the Space for every packet in the log', async () => {
    const f = await buildFamily();
    for (const r of await readPacketRecords(f.owner.storage)) {
      const env = decodeEnvelope(r.raw).env;
      expect(env.codec).toBe(SPACE_CODEC_ID);
      expect(parseHeader(env.body)!.scope).toBe(f.space.id);
    }
    await f.g.close();
  });
});
