/** Key grants: epoch keys wrapped for one recipient device (research R-03). */

import { b64urlDecode, b64urlEncode } from '@sync/core';
import { base32Decode, concat, hex, randomBytes, u32be, unhex, utf8 } from './bytes';
import { aesOpen, aesSeal, deriveShared, generateAgreeKeyPair, hkdf, importAesKey } from './suite';
import { keyIdOf } from './ids';

export interface GrantItem {
  epoch: number;
  keyId: string; // hex, 16 chars
  nonce: string; // base64url, 12 bytes
  wrapped: string; // base64url AES-GCM(epoch key)
}

export interface GrantBody {
  to: string;
  scope: string;
  /** Ephemeral X25519 public key, base64url. */
  eph: string;
  items: GrantItem[];
}

const info = (scope: string, epoch: number, device: string) =>
  concat(utf8.encode('sync-grant/1'), base32Decode(scope), u32be(epoch), utf8.encode(device));
const aad = (to: string, scope: string, epoch: number, keyId: string) =>
  concat(utf8.encode(to), base32Decode(scope), u32be(epoch), unhex(keyId));

export async function wrapKeys(
  scope: string,
  recipient: { deviceId: string; agreePub: Uint8Array },
  keys: ReadonlyArray<{ epoch: number; keyId: string; raw: Uint8Array }>,
): Promise<GrantBody> {
  const eph = await generateAgreeKeyPair();
  const shared = await deriveShared(eph.privateKey, recipient.agreePub);
  const items: GrantItem[] = [];
  for (const k of keys) {
    const wrapKey = await importAesKey(
      await hkdf(shared, new Uint8Array(32), info(scope, k.epoch, recipient.deviceId)),
    );
    const nonce = randomBytes(12);
    const wrapped = await aesSeal(wrapKey, nonce, k.raw, aad(recipient.deviceId, scope, k.epoch, k.keyId));
    items.push({
      epoch: k.epoch,
      keyId: k.keyId,
      nonce: b64urlEncode(nonce),
      wrapped: b64urlEncode(wrapped),
    });
  }
  return { to: recipient.deviceId, scope, eph: b64urlEncode(eph.publicRaw), items };
}

/** The unwrapped raw keys that verify against their `keyId`. Items that fail are skipped. */
export async function unwrapKeys(
  agreePriv: CryptoKey,
  deviceId: string,
  grant: GrantBody,
): Promise<Array<{ epoch: number; keyId: string; raw: Uint8Array }>> {
  if (grant.to !== deviceId) return [];
  const out: Array<{ epoch: number; keyId: string; raw: Uint8Array }> = [];
  let shared: Uint8Array;
  try {
    shared = await deriveShared(agreePriv, b64urlDecode(grant.eph));
  } catch {
    return [];
  }
  for (const it of grant.items) {
    try {
      const wrapKey = await importAesKey(
        await hkdf(shared, new Uint8Array(32), info(grant.scope, it.epoch, deviceId)),
      );
      const raw = await aesOpen(
        wrapKey,
        b64urlDecode(it.nonce),
        b64urlDecode(it.wrapped),
        aad(deviceId, grant.scope, it.epoch, it.keyId),
      );
      if (!raw || raw.byteLength !== 32) continue;
      if (hex(await keyIdOf(raw)) !== it.keyId) continue;
      out.push({ epoch: it.epoch, keyId: it.keyId, raw });
    } catch {
      // skip malformed items
    }
  }
  return out;
}
