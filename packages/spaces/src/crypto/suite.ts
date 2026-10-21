/**
 * Cipher suite 1 (research R-01): Ed25519 signatures, X25519 key agreement, HKDF-SHA-256, AES-256-GCM.
 * Web Crypto only. There is no fallback suite and no plaintext fallback.
 */

import { bs, concat } from './bytes';

export const SUITE_ID = 'suite-1';
export const SIGNATURE_BYTES = 64;
export const NONCE_BYTES = 12;
export const KEY_BYTES = 32;

const subtle = () => globalThis.crypto.subtle;

export interface KeyPairInfo {
  privateKey: CryptoKey;
  /** Raw 32-byte public key. */
  publicRaw: Uint8Array;
}

async function pair(alg: 'Ed25519' | 'X25519', usages: KeyUsage[], extractable: boolean): Promise<KeyPairInfo> {
  const kp = (await subtle().generateKey({ name: alg }, extractable, usages)) as CryptoKeyPair;
  return { privateKey: kp.privateKey, publicRaw: new Uint8Array(await subtle().exportKey('raw', kp.publicKey)) };
}

/** Private keys are non-extractable unless a test asks otherwise. */
export const generateSignKeyPair = (extractable = false) => pair('Ed25519', ['sign', 'verify'], extractable);
export const generateAgreeKeyPair = (extractable = false) => pair('X25519', ['deriveBits'], extractable);

export async function signBytes(privateKey: CryptoKey, bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().sign({ name: 'Ed25519' }, privateKey, bs(bytes)));
}

const verifyKeyCache = new Map<string, Promise<CryptoKey>>();

function importVerifyKey(publicRaw: Uint8Array): Promise<CryptoKey> {
  const k = Array.from(publicRaw, (b) => b.toString(16).padStart(2, '0')).join('');
  let p = verifyKeyCache.get(k);
  if (!p) {
    if (verifyKeyCache.size > 4096) verifyKeyCache.clear();
    p = subtle().importKey('raw', bs(publicRaw), { name: 'Ed25519' }, false, ['verify']);
    verifyKeyCache.set(k, p);
  }
  return p;
}

/** False for any bad key, bad length or bad signature. Never throws. */
export async function verifySignature(publicRaw: Uint8Array, sig: Uint8Array, bytes: Uint8Array): Promise<boolean> {
  if (publicRaw.byteLength !== 32 || sig.byteLength !== SIGNATURE_BYTES) return false;
  try {
    return await subtle().verify({ name: 'Ed25519' }, await importVerifyKey(publicRaw), bs(sig), bs(bytes));
  } catch {
    return false;
  }
}

/** X25519 shared secret (32 bytes). Rejects low-order points (all-zero output). */
export async function deriveShared(privateKey: CryptoKey, peerPublicRaw: Uint8Array): Promise<Uint8Array> {
  const peer = await subtle().importKey('raw', bs(peerPublicRaw), { name: 'X25519' }, false, []);
  const bits = new Uint8Array(await subtle().deriveBits({ name: 'X25519', public: peer }, privateKey, 256));
  if (bits.every((b) => b === 0)) throw new Error('degenerate shared secret');
  return bits;
}

export async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length = 32): Promise<Uint8Array> {
  const base = await subtle().importKey('raw', bs(ikm), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: bs(salt), info: bs(info) }, base, length * 8));
}

export function importAesKey(raw: Uint8Array, extractable = false): Promise<CryptoKey> {
  return subtle().importKey('raw', bs(raw), { name: 'AES-GCM' }, extractable, ['encrypt', 'decrypt']);
}

export async function generateAesKey(extractable = false): Promise<CryptoKey> {
  return (await subtle().generateKey({ name: 'AES-GCM', length: 256 }, extractable, ['encrypt', 'decrypt'])) as CryptoKey;
}

/** AES-256-GCM; the 16-byte tag is appended to the ciphertext. */
export async function aesSeal(key: CryptoKey, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: bs(nonce), additionalData: bs(aad), tagLength: 128 }, key, bs(plaintext)));
}

/** Null on any failure (wrong key, tampered data or AAD). */
export async function aesOpen(key: CryptoKey, nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: bs(nonce), additionalData: bs(aad), tagLength: 128 }, key, bs(ciphertext)));
  } catch {
    return null;
  }
}

export { concat };
