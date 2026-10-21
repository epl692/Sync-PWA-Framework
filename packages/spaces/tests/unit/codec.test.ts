// T022: aes-gcm-space/1 against contracts/crypto-envelope.md.
import { describe, expect, it } from 'vitest';
import { base32, buildEnvelope, decodeEnvelope, encodeEnvelope, type PacketBody } from '@sync/core';
import { generateAesKey } from '../../src/crypto/suite';
import { concat } from '../../src/crypto/bytes';
import { HEADER_BYTES, NoWriteKeyError, SpaceCodec, buildHeader, parseHeader, type KeyAccess } from '../../src/codec/spaceCodec';

const SPACE = base32(new Uint8Array(16).fill(3));
const SHARE = base32(new Uint8Array(16).fill(4));

async function harness() {
  const keys = new Map<string, { epoch: number; keyId: string; key: CryptoKey }>();
  const add = async (scope: string, epoch: number, keyId: string) => {
    const k = { epoch, keyId, key: await generateAesKey() };
    keys.set(`${scope}:${keyId}`, k);
    return k;
  };
  const writeKeys = new Map<string, string>();
  let used = 0;
  const access: KeyAccess = {
    scopeFor: (_space, body) => (body.obj === 'shared' ? SHARE : SPACE),
    writeKey: async (scope) => {
      const id = writeKeys.get(scope);
      return id ? keys.get(`${scope}:${id}`) : undefined;
    },
    readKey: async (scope, keyId) => keys.get(`${scope}:${keyId}`)?.key,
    used: async () => ++used,
  };
  return { keys, add, writeKeys, access, codec: new SpaceCodec(access) };
}

const body = (extra: Partial<PacketBody> = {}): PacketBody => ({ obj: 'o1', op: 'create', type: 'item', schemaVersion: 1, fields: { title: 'secret-title' }, ...extra });
const ctx = (over: Partial<{ id: string; seq: number; clock: string }> = {}) => ({
  space: SPACE,
  author: 'AUTHOR',
  envelope: { v: 1, id: over.id ?? 'AUTHOR:1', seq: over.seq ?? 1, clock: over.clock ?? '000000000001-0000-AUTHOR', codec: 'aes-gcm-space/1' },
});

describe('aes-gcm-space/1', () => {
  it('round trips, and the body bytes follow the documented layout', async () => {
    const h = await harness();
    const k = await h.add(SPACE, 4, '0123456789abcdef');
    h.writeKeys.set(SPACE, k.keyId);
    const bytes = await h.codec.encode(body(), ctx());
    expect(bytes[0]).toBe(1);
    expect(bytes.byteLength).toBeGreaterThan(HEADER_BYTES + 12 + 16);
    expect(parseHeader(bytes)).toEqual({ fmt: 1, scope: SPACE, epoch: 4, keyId: '0123456789abcdef' });
    expect(bytes.slice(0, HEADER_BYTES)).toEqual(buildHeader(SPACE, 4, '0123456789abcdef'));
    const r = await h.codec.decode(bytes, ctx());
    expect(r).toEqual({ ok: true, body: body() });
  });

  it('never leaks plaintext into the readable bytes', async () => {
    const h = await harness();
    const k = await h.add(SPACE, 0, 'aaaaaaaaaaaaaaaa');
    h.writeKeys.set(SPACE, k.keyId);
    const bytes = await h.codec.encode(body(), ctx());
    expect(new TextDecoder('latin1').decode(bytes)).not.toContain('secret-title');
    expect(new TextDecoder('latin1').decode(bytes)).not.toContain('item');
  });

  it('uses a fresh nonce each time', async () => {
    const h = await harness();
    const k = await h.add(SPACE, 0, 'aaaaaaaaaaaaaaaa');
    h.writeKeys.set(SPACE, k.keyId);
    const a = await h.codec.encode(body(), ctx());
    const b = await h.codec.encode(body(), ctx());
    expect(a.slice(HEADER_BYTES, HEADER_BYTES + 12)).not.toEqual(b.slice(HEADER_BYTES, HEADER_BYTES + 12));
  });

  it('binds ciphertext to its envelope: a changed id, seq, clock, author or space fails', async () => {
    const h = await harness();
    const k = await h.add(SPACE, 0, 'aaaaaaaaaaaaaaaa');
    h.writeKeys.set(SPACE, k.keyId);
    const bytes = await h.codec.encode(body(), ctx());
    for (const bad of [ctx({ id: 'AUTHOR:2' }), ctx({ seq: 2 }), ctx({ clock: '000000000002-0000-AUTHOR' })]) {
      expect(await h.codec.decode(bytes, bad)).toEqual({ ok: false, reason: 'malformed' });
    }
    expect(await h.codec.decode(bytes, { ...ctx(), author: 'MALLORY' })).toEqual({ ok: false, reason: 'malformed' });
    expect(await h.codec.decode(bytes, { ...ctx(), space: base32(new Uint8Array(16).fill(9)) })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a tampered header or ciphertext as malformed', async () => {
    const h = await harness();
    const k = await h.add(SPACE, 0, 'aaaaaaaaaaaaaaaa');
    h.writeKeys.set(SPACE, k.keyId);
    const bytes = await h.codec.encode(body(), ctx());
    const epochFlip = bytes.slice();
    epochFlip[20]! ^= 1; // epoch byte: header is in the AAD
    expect(await h.codec.decode(epochFlip, ctx())).toMatchObject({ ok: false });
    const ctFlip = bytes.slice();
    ctFlip[bytes.length - 1]! ^= 1;
    expect(await h.codec.decode(ctFlip, ctx())).toEqual({ ok: false, reason: 'malformed' });
  });

  it('reports missing-key when the key is unknown, unknown-codec for another format, malformed for short input', async () => {
    const h = await harness();
    const k = await h.add(SPACE, 0, 'aaaaaaaaaaaaaaaa');
    h.writeKeys.set(SPACE, k.keyId);
    const bytes = await h.codec.encode(body(), ctx());
    h.keys.clear();
    expect(await h.codec.decode(bytes, ctx())).toEqual({ ok: false, reason: 'missing-key' });
    expect(await h.codec.decode(concat(new Uint8Array([9]), bytes.slice(1)), ctx())).toEqual({ ok: false, reason: 'unknown-codec' });
    expect(await h.codec.decode(new Uint8Array([1, 2, 3]), ctx())).toEqual({ ok: false, reason: 'malformed' });
    expect(await h.codec.decode(bytes.slice(0, 40), ctx())).toEqual({ ok: false, reason: 'malformed' });
  });

  it('picks the key by keyId, so two keys of the same epoch both decrypt', async () => {
    const h = await harness();
    const a = await h.add(SPACE, 5, 'aaaaaaaaaaaaaaaa');
    const b = await h.add(SPACE, 5, 'bbbbbbbbbbbbbbbb');
    h.writeKeys.set(SPACE, a.keyId);
    const fromA = await h.codec.encode(body({ obj: 'x' }), ctx());
    h.writeKeys.set(SPACE, b.keyId);
    const fromB = await h.codec.encode(body({ obj: 'y' }), ctx());
    expect(parseHeader(fromA)!.keyId).toBe('aaaaaaaaaaaaaaaa');
    expect(parseHeader(fromB)!.keyId).toBe('bbbbbbbbbbbbbbbb');
    expect((await h.codec.decode(fromA, ctx())).ok).toBe(true);
    expect((await h.codec.decode(fromB, ctx())).ok).toBe(true);
  });

  it('encrypts an override-share object under the share scope, and refuses to write without a key', async () => {
    const h = await harness();
    const sk = await h.add(SHARE, 0, 'cccccccccccccccc');
    h.writeKeys.set(SHARE, sk.keyId);
    const bytes = await h.codec.encode(body({ obj: 'shared' }), ctx());
    expect(parseHeader(bytes)!.scope).toBe(SHARE);
    await expect(h.codec.encode(body(), ctx())).rejects.toBeInstanceOf(NoWriteKeyError); // no Space key
  });

  it('works inside a real envelope: the codec output is the envelope body and survives encode/decode', async () => {
    const h = await harness();
    const k = await h.add(SPACE, 0, 'aaaaaaaaaaaaaaaa');
    h.writeKeys.set(SPACE, k.keyId);
    const c = ctx();
    const bytes = await h.codec.encode(body(), c);
    const env = buildEnvelope({ author: 'AUTHOR', seq: 1, space: SPACE, clock: c.envelope.clock, codec: 'aes-gcm-space/1', body: bytes, sig: null });
    const back = decodeEnvelope(encodeEnvelope(env)).env;
    expect((await h.codec.decode(back.body, { space: back.space, author: back.author, envelope: { v: back.v, id: back.id, seq: back.seq, clock: back.clock, codec: back.codec } })).ok).toBe(true);
  });
});
