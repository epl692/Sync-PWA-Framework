/** Self-certifying IDs (research R-02). */

import { base32 } from '@sync/core';
import { concat, sha256, utf8 } from './bytes';

/** deviceId = base32(SHA-256(signPub))[0..128 bits] = 26 characters. */
export async function deviceIdFromSignPub(signPub: Uint8Array): Promise<string> {
  return base32((await sha256(signPub)).slice(0, 16));
}

/** The Space ID is bound to the creating key, so nobody else can author a valid genesis for it. */
export async function spaceIdFor(ownerSignPub: Uint8Array, nonce: Uint8Array): Promise<string> {
  return base32((await sha256(concat(utf8.encode('space/1'), ownerSignPub, nonce))).slice(0, 16));
}

/** First 8 bytes of SHA-256 of the epoch key. */
export async function keyIdOf(rawKey: Uint8Array): Promise<Uint8Array> {
  return (await sha256(rawKey)).slice(0, 8);
}
