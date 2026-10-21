/**
 * Sealed handshake messages: X25519 ephemeral-static key agreement, HKDF, AES-256-GCM.
 * Only the device the message is addressed to can open it; relays and transports see opaque bytes.
 *
 * wire = 0x01 || ephemeralPublic(32) || nonce(12) || ciphertext+tag
 * The `context` (for example "join-request") is bound as authenticated data and into the key derivation,
 * so a reply can never be replayed as a request.
 */

import { aesOpen, aesSeal, concat, deriveShared, generateAgreeKeyPair, hkdf, importAesKey, randomBytes, utf8, type LocalDevice } from '@sync/spaces';

const FMT = 1;

async function keyFor(shared: Uint8Array, context: string) {
  return importAesKey(await hkdf(shared, new Uint8Array(32), concat(utf8.encode('sync-join/1'), utf8.encode(context))));
}

export async function sealTo(receiverAgreePub: Uint8Array, plaintext: Uint8Array, context: string): Promise<Uint8Array> {
  const eph = await generateAgreeKeyPair();
  const key = await keyFor(await deriveShared(eph.privateKey, receiverAgreePub), context);
  const nonce = randomBytes(12);
  const ct = await aesSeal(key, nonce, plaintext, utf8.encode(context));
  return concat(new Uint8Array([FMT]), eph.publicRaw, nonce, ct);
}

/** Null when the bytes are not addressed to this device, are for another context, or were altered. */
export async function openSealed(device: LocalDevice, bytes: Uint8Array, context: string): Promise<Uint8Array | null> {
  if (bytes.byteLength < 1 + 32 + 12 + 16 || bytes[0] !== FMT) return null;
  try {
    const key = await keyFor(await device.deriveShared(bytes.slice(1, 33)), context);
    return await aesOpen(key, bytes.slice(33, 45), bytes.slice(45), utf8.encode(context));
  } catch {
    return null;
  }
}
