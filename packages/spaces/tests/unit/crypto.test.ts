// T020: known-answer and unit tests for suite-1.
import { describe, expect, it } from 'vitest';
import { createCipheriv, createHash } from 'node:crypto';
import { b64urlEncode, base32 } from '@sync/core';
import { bs, concat, hex, unhex, utf8 } from '../../src/crypto/bytes';
import { deviceIdFromSignPub, keyIdOf, spaceIdFor } from '../../src/crypto/ids';
import {
  aesOpen,
  aesSeal,
  deriveShared,
  generateAgreeKeyPair,
  generateAesKey,
  generateSignKeyPair,
  hkdf,
  importAesKey,
  signBytes,
  verifySignature,
} from '../../src/crypto/suite';
import { detectSupport } from '../../src/crypto/support';
import { unwrapKeys, wrapKeys } from '../../src/crypto/wrap';

const subtle = globalThis.crypto.subtle;

describe('known answers', () => {
  it('Ed25519 (RFC 8032 test 1): signature is exactly the published one and verifies', async () => {
    const seed = unhex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
    const pub = unhex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
    const key = await subtle.importKey(
      'jwk',
      { kty: 'OKP', crv: 'Ed25519', d: b64urlEncode(seed), x: b64urlEncode(pub) },
      { name: 'Ed25519' },
      false,
      ['sign'],
    );
    const sig = await signBytes(key, new Uint8Array());
    expect(hex(sig)).toBe(
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    );
    expect(await verifySignature(pub, sig, new Uint8Array())).toBe(true);
  });

  it('X25519 (RFC 7748 6.1): both sides derive the published shared secret', async () => {
    const alicePriv = unhex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
    const alicePub = unhex('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a');
    const bobPub = unhex('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f');
    const key = await subtle.importKey(
      'jwk',
      { kty: 'OKP', crv: 'X25519', d: b64urlEncode(alicePriv), x: b64urlEncode(alicePub) },
      { name: 'X25519' },
      false,
      ['deriveBits'],
    );
    expect(hex(await deriveShared(key, bobPub))).toBe(
      '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742',
    );
  });

  it('HKDF-SHA-256 (RFC 5869 test case 1)', async () => {
    const okm = await hkdf(
      new Uint8Array(22).fill(0x0b),
      unhex('000102030405060708090a0b0c'),
      unhex('f0f1f2f3f4f5f6f7f8f9'),
      42,
    );
    expect(hex(okm)).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });

  it('AES-256-GCM matches an independent implementation (node:crypto), including AAD and tag layout', async () => {
    const key = unhex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    const nonce = unhex('a0a1a2a3a4a5a6a7a8a9aaab');
    const aad = utf8.encode('header');
    const pt = utf8.encode('attack at dawn');
    const c = createCipheriv('aes-256-gcm', key, nonce);
    c.setAAD(aad);
    const expected = concat(
      new Uint8Array(c.update(pt)),
      new Uint8Array(c.final()),
      new Uint8Array(c.getAuthTag()),
    );
    const sealed = await aesSeal(await importAesKey(key), nonce, pt, aad);
    expect(hex(sealed)).toBe(hex(expected));
    expect(await aesOpen(await importAesKey(key), nonce, sealed, aad)).toEqual(pt);
  });

  it('derives device and Space IDs by a documented rule', async () => {
    const pub = unhex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
    const expected = base32(new Uint8Array(createHash('sha256').update(pub).digest()).slice(0, 16));
    expect(await deviceIdFromSignPub(pub)).toBe(expected);
    expect(expected).toHaveLength(26);
    const nonce = new Uint8Array(16).fill(7);
    const space = base32(
      new Uint8Array(
        createHash('sha256')
          .update(concat(utf8.encode('space/1'), pub, nonce))
          .digest(),
      ).slice(0, 16),
    );
    expect(await spaceIdFor(pub, nonce)).toBe(space);
    expect(await keyIdOf(new Uint8Array(32))).toEqual(
      new Uint8Array(createHash('sha256').update(new Uint8Array(32)).digest()).slice(0, 8),
    );
  });
});

describe('signatures', () => {
  it('rejects wrong key, wrong message, truncated signature and bad key length without throwing', async () => {
    const a = await generateSignKeyPair();
    const b = await generateSignKeyPair();
    const msg = utf8.encode('m');
    const sig = await signBytes(a.privateKey, msg);
    expect(await verifySignature(a.publicRaw, sig, msg)).toBe(true);
    expect(await verifySignature(b.publicRaw, sig, msg)).toBe(false);
    expect(await verifySignature(a.publicRaw, sig, utf8.encode('n'))).toBe(false);
    expect(await verifySignature(a.publicRaw, sig.slice(1), msg)).toBe(false);
    expect(await verifySignature(a.publicRaw.slice(1), sig, msg)).toBe(false);
  });

  it('generated private keys are non-extractable', async () => {
    const a = await generateSignKeyPair();
    expect(a.privateKey.extractable).toBe(false);
    await expect(subtle.exportKey('pkcs8', a.privateKey)).rejects.toThrow();
    expect((await generateAgreeKeyPair()).privateKey.extractable).toBe(false);
  });
});

describe('AES-GCM failure modes', () => {
  it('returns null for wrong key, wrong AAD, tampered ciphertext and short input', async () => {
    const k1 = await generateAesKey();
    const k2 = await generateAesKey();
    const nonce = new Uint8Array(12);
    const sealed = await aesSeal(k1, nonce, utf8.encode('x'), utf8.encode('a'));
    expect(await aesOpen(k2, nonce, sealed, utf8.encode('a'))).toBeNull();
    expect(await aesOpen(k1, nonce, sealed, utf8.encode('b'))).toBeNull();
    const bad = sealed.slice();
    bad[0]! ^= 1;
    expect(await aesOpen(k1, nonce, bad, utf8.encode('a'))).toBeNull();
    expect(await aesOpen(k1, nonce, new Uint8Array(3), utf8.encode('a'))).toBeNull();
    void bs;
  });
});

describe('key grants', () => {
  const scope = base32(new Uint8Array(16).fill(1));
  async function setup() {
    const agree = await generateAgreeKeyPair();
    const raw = crypto.getRandomValues(new Uint8Array(32));
    return { agree, raw, keyId: hex(await keyIdOf(raw)) };
  }

  it('round trips several epochs to the right device', async () => {
    const { agree, raw, keyId } = await setup();
    const raw2 = crypto.getRandomValues(new Uint8Array(32));
    const keyId2 = hex(await keyIdOf(raw2));
    const grant = await wrapKeys(scope, { deviceId: 'DEVICE1', agreePub: agree.publicRaw }, [
      { epoch: 0, keyId, raw },
      { epoch: 1, keyId: keyId2, raw: raw2 },
    ]);
    const out = await unwrapKeys(agree.privateKey, 'DEVICE1', grant);
    expect(out.map((o) => [o.epoch, o.keyId])).toEqual([
      [0, keyId],
      [1, keyId2],
    ]);
    expect(out[0]!.raw).toEqual(raw);
  });

  it('is unreadable for another device, a wrong recipient ID, or a modified item', async () => {
    const { agree, raw, keyId } = await setup();
    const other = await generateAgreeKeyPair();
    const grant = await wrapKeys(scope, { deviceId: 'DEVICE1', agreePub: agree.publicRaw }, [
      { epoch: 0, keyId, raw },
    ]);
    expect(await unwrapKeys(other.privateKey, 'DEVICE1', grant)).toEqual([]);
    expect(await unwrapKeys(agree.privateKey, 'DEVICE2', grant)).toEqual([]);
    expect(
      await unwrapKeys(agree.privateKey, 'DEVICE1', { ...grant, items: [{ ...grant.items[0]!, epoch: 5 }] }),
    ).toEqual([]);
    expect(
      await unwrapKeys(agree.privateKey, 'DEVICE1', { ...grant, scope: base32(new Uint8Array(16).fill(2)) }),
    ).toEqual([]);
  });

  it('skips an item whose key does not match its keyId', async () => {
    const { agree, raw } = await setup();
    const grant = await wrapKeys(scope, { deviceId: 'DEVICE1', agreePub: agree.publicRaw }, [
      { epoch: 0, keyId: '0000000000000000', raw },
    ]);
    expect(await unwrapKeys(agree.privateKey, 'DEVICE1', grant)).toEqual([]);
  });
});

describe('support detection', () => {
  it('reports ok where Ed25519 and X25519 exist', async () => {
    expect(await detectSupport()).toEqual({ ok: true });
  });
});
