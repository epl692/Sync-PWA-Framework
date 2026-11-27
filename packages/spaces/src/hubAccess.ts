/**
 * Hub access keys (spec 005, amendment S-2; specs/005-bluetooth-transport/contracts/hub-access.md).
 *
 * A Hub holds no content keys, yet must check that a client is a member of a Space it serves. Each Space epoch therefore
 * derives a separate Ed25519 *access* key. The Hub gets only the public half (in a serve code) and verifies a signed
 * challenge. The derivation is one-way and domain-separated, so neither half lets anyone recover the epoch key or decrypt.
 */

import { b64urlDecode } from './crypto/b64';
import { concat, u32be, utf8 } from './crypto/bytes';
import { hkdf, verifySignature } from './crypto/suite';

export const HUB_ACCESS_LABEL = 'sync-hub-access/1';
export const HUB_AUTH_LABEL = 'sync-hub-auth/1';

const SALT = new Uint8Array(32);
// PKCS#8 prefix for an Ed25519 private key; Web Crypto cannot import a raw private seed.
const PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

export interface HubAccessKey {
  /** The 32-byte Ed25519 seed. Secret: only a "link code" ever carries it. */
  seed: Uint8Array;
  publicRaw: Uint8Array;
  privateKey: CryptoKey;
}


/** Rebuild an access key from its seed (a link code, or a derivation). */
export async function hubAccessFromSeed(seed: Uint8Array): Promise<HubAccessKey> {
  if (seed.byteLength !== 32) throw new Error('hub access seed must be 32 bytes');
  const subtle = globalThis.crypto.subtle;
  const privateKey = await subtle.importKey(
    'pkcs8',
    concat(PKCS8_PREFIX, seed) as unknown as BufferSource,
    { name: 'Ed25519' },
    true,
    ['sign'],
  );
  const jwk = await subtle.exportKey('jwk', privateKey);
  if (!jwk.x) throw new Error('cannot derive the public key');
  // re-import non-extractable so the secret cannot be read back out of the CryptoKey
  const sealed = await subtle.importKey('pkcs8', concat(PKCS8_PREFIX, seed) as unknown as BufferSource, { name: 'Ed25519' }, false, ['sign']);
  return { seed: seed.slice(), publicRaw: b64urlDecode(jwk.x), privateKey: sealed };
}

/** `HKDF-SHA-256(epochKey, salt = 0x00*32, info = label || spaceId(16 B) || epoch(4 B BE), 32)` -> Ed25519 seed. */
export async function deriveHubAccess(epochKey: Uint8Array, spaceId: Uint8Array, epoch: number): Promise<HubAccessKey> {
  const seed = await hkdf(epochKey, SALT, concat(utf8.encode(HUB_ACCESS_LABEL), spaceId, u32be(epoch)), 32);
  return hubAccessFromSeed(seed);
}

/** The bytes a member signs for a Hub: bound to the Hub, this session's two nonces, the Space and the epoch. */
export function hubAuthMessage(a: {
  hubFingerprint: Uint8Array;
  nc: Uint8Array;
  nh: Uint8Array;
  space: Uint8Array;
  epoch: number;
}): Uint8Array {
  return concat(utf8.encode(HUB_AUTH_LABEL), a.hubFingerprint, a.nc, a.nh, a.space, u32be(a.epoch));
}

export async function proveHubChallenge(key: HubAccessKey, message: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.sign({ name: 'Ed25519' }, key.privateKey, message as unknown as BufferSource));
}

/** What a Hub runs. False for any bad key, length or signature; never throws. */
export function verifyHubProof(publicRaw: Uint8Array, sig: Uint8Array, message: Uint8Array): Promise<boolean> {
  return verifySignature(publicRaw, sig, message);
}


