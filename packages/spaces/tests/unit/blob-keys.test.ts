// T010 (S-1, spec 004): blob keys derived per scope and epoch; the blob engine never sees a raw epoch key.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBlobKeys, Keystore, memoryKeyDb } from '../../src';
import { base32Decode } from '../../src/crypto/bytes';

const vec = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'blobs', 'tests', 'vectors', 'keys.json'), 'utf8')) as Record<string, string>;
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16)));
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const scopeString = (raw: Uint8Array): string => {
  let bits = 0, value = 0, out = '';
  for (const b of raw) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
};

async function setup(epochs: Array<{ epoch: number; raw: Uint8Array }>, scope = scopeString(fromHex(vec.scopeId))) {
  const keystore = await Keystore.open(memoryKeyDb());
  await keystore.createDevice();
  for (const e of epochs) await keystore.putEpochKey(scope, e.epoch, e.raw, 'self');
  const current = { epoch: 0 };
  const keys = {
    scopeFor: (space: string) => space,
    writeKey: async (s: string) => {
      const held = await keystore.epochs(s);
      const top = held.filter((h) => h.epoch <= (current.epoch || 1e9)).at(-1);
      return top && { epoch: top.epoch, keyId: top.keyId, key: (await keystore.aesKey(s, top.keyId))! };
    },
  };
  return { keystore, blobKeys: createBlobKeys({ keystore, keys }), scope, current };
}

describe('S-1 blobKeys', () => {
  it('derives the keys of the known-answer vector (HKDF, scope ID, key ID)', async () => {
    const { blobKeys, scope } = await setup([{ epoch: 1, raw: fromHex(vec.epochKey) }]);
    expect(Array.from(base32Decode(scope))).toEqual(Array.from(fromHex(vec.scopeId)));
    const w = (await blobKeys.forWrite(scope))!;
    expect(w.keyId).toBe(vec.keyId);
    expect(Array.from(w.scopeId)).toEqual(Array.from(fromHex(vec.scopeId)));
    // prove the derived keys equal the vector by sealing and MAC-ing with them and with the vector's raw keys
    const iv = new Uint8Array(12);
    const aes = await crypto.subtle.importKey('raw', fromHex(vec.encKey), 'AES-GCM', false, ['encrypt']);
    const msg = new Uint8Array([1, 2, 3]);
    const a = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, w.enc, msg));
    const b = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, msg));
    expect(Array.from(a)).toEqual(Array.from(b));
    const hm = await crypto.subtle.importKey('raw', fromHex(vec.macKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const m1 = new Uint8Array(await crypto.subtle.sign('HMAC', w.mac, msg));
    const m2 = new Uint8Array(await crypto.subtle.sign('HMAC', hm, msg));
    expect(Array.from(m1)).toEqual(Array.from(m2));
  });

  it('keeps derived CryptoKeys non-extractable', async () => {
    const { blobKeys, scope } = await setup([{ epoch: 1, raw: fromHex(vec.epochKey) }]);
    const w = (await blobKeys.forWrite(scope))!;
    expect(w.enc.extractable).toBe(false);
    expect(w.mac.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', w.enc)).rejects.toThrow();
  });

  it('writes with the current epoch and still reads older epochs after a rotation', async () => {
    const e1 = fromHex(vec.epochKey);
    const e2 = new Uint8Array(32).fill(7);
    const { blobKeys, scope, keystore } = await setup([{ epoch: 1, raw: e1 }, { epoch: 2, raw: e2 }]);
    const w = (await blobKeys.forWrite(scope))!;
    expect(w.epoch).toBe(2);
    const old = (await keystore.epochs(scope)).find((e) => e.epoch === 1)!;
    const r = await blobKeys.forRead(scope, old.keyId);
    expect(r).toBeDefined();
    expect(old.keyId).toBe(vec.keyId);
    expect(w.keyId).not.toBe(old.keyId);
  });

  it('returns undefined for an epoch the device was never granted, and for a scope it holds nothing for', async () => {
    const { blobKeys, scope } = await setup([{ epoch: 1, raw: fromHex(vec.epochKey) }]);
    expect(await blobKeys.forRead(scope, 'ffffffffffffffff')).toBeUndefined();
    const other = scopeString(new Uint8Array(16).fill(9));
    expect(await blobKeys.forWrite(other)).toBeUndefined();
    expect(await blobKeys.forRead(other, vec.keyId)).toBeUndefined();
  });

  it('gives different keys to different scopes holding the same epoch key bytes', async () => {
    const otherScope = scopeString(new Uint8Array(16).fill(5));
    const a = await setup([{ epoch: 1, raw: fromHex(vec.epochKey) }]);
    await a.keystore.putEpochKey(otherScope, 1, fromHex(vec.epochKey), 'self');
    const w1 = (await a.blobKeys.forWrite(a.scope))!;
    const w2 = (await a.blobKeys.forWrite(otherScope))!;
    const iv = new Uint8Array(12);
    const x = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, w1.enc, new Uint8Array([1])));
    const y = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, w2.enc, new Uint8Array([1])));
    expect(Array.from(x)).not.toEqual(Array.from(y));
  });

  it('fires onKeysChanged when a new key is stored and not for a key already held', async () => {
    const { blobKeys, scope, keystore } = await setup([{ epoch: 1, raw: fromHex(vec.epochKey) }]);
    const seen: string[] = [];
    const off = blobKeys.onKeysChanged((s) => seen.push(s));
    await keystore.putEpochKey(scope, 1, fromHex(vec.epochKey), 'grant'); // already held
    expect(seen).toEqual([]);
    await keystore.putEpochKey(scope, 2, new Uint8Array(32).fill(3), 'grant');
    expect(seen).toEqual([scope]);
    off();
    await keystore.putEpochKey(scope, 3, new Uint8Array(32).fill(4), 'grant');
    expect(seen).toEqual([scope]);
  });

  it('a key that arrives later becomes readable (a missing key is not cached)', async () => {
    const { blobKeys, scope, keystore } = await setup([]);
    expect(await blobKeys.forRead(scope, vec.keyId)).toBeUndefined();
    await keystore.putEpochKey(scope, 1, fromHex(vec.epochKey), 'grant');
    expect(await blobKeys.forRead(scope, vec.keyId)).toBeDefined();
  });
});
