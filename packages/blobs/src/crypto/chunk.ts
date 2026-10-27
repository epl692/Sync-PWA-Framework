/**
 * Chunk sealing and opening for `blob-aes-gcm/1` (contracts/blob-format.md). Deterministic: the same key, index and
 * plaintext always give the same stored bytes, which is what makes dedup by ID possible. Needs only Web Crypto handles,
 * never raw key bytes.
 */

import { NONCE_BYTES, CHUNK_BYTES, FMT, TAG_BYTES } from '../format/constants';
import { concat, sha256, u32, u64, unhex, utf8 } from '../format/bytes';
import { BlobIntegrityError } from '../types';

export { sha256 } from '../format/bytes';

export interface ChunkKeys {
  /** Raw 128-bit scope ID. */
  scopeId: Uint8Array;
  /** 16 hex chars. */
  keyId: string;
  /** AES-256-GCM. */
  enc: CryptoKey;
  /** HMAC-SHA-256, for nonce derivation. */
  mac: CryptoKey;
}

const subtle = () => globalThis.crypto.subtle;
const N = utf8.encode('n');

function aad(k: Pick<ChunkKeys, 'scopeId' | 'keyId'>, size: number, index: number): Uint8Array {
  return concat(new Uint8Array([FMT]), k.scopeId, unhex(k.keyId), u64(size), u32(CHUNK_BYTES), u32(index));
}

/** Seal plaintext chunk `index` of a blob of `size` bytes. `stored` is `nonce ‖ ciphertext ‖ tag`; `digest` is SHA-256(stored). */
export async function sealChunk(k: ChunkKeys, size: number, index: number, plain: Uint8Array): Promise<{ stored: Uint8Array; digest: Uint8Array }> {
  const pd = await sha256(plain);
  const nonce = new Uint8Array(await subtle().sign('HMAC', k.mac, concat(N, u32(index), pd) as BufferSource)).subarray(0, NONCE_BYTES).slice();
  const ct = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad(k, size, index) as BufferSource, tagLength: 128 }, k.enc, plain as BufferSource),
  );
  const stored = concat(nonce, ct);
  return { stored, digest: await sha256(stored) };
}

/** Decrypt a stored chunk. Throws BlobIntegrityError on any authentication failure (wrong key, index, size or tampering). */
export async function openChunk(k: ChunkKeys, size: number, index: number, stored: Uint8Array): Promise<Uint8Array> {
  if (stored.length < NONCE_BYTES + TAG_BYTES) throw new BlobIntegrityError('stored chunk is too short');
  try {
    const plain = await subtle().decrypt(
      { name: 'AES-GCM', iv: stored.subarray(0, NONCE_BYTES) as BufferSource, additionalData: aad(k, size, index) as BufferSource, tagLength: 128 },
      k.enc,
      stored.subarray(NONCE_BYTES) as BufferSource,
    );
    return new Uint8Array(plain);
  } catch {
    throw new BlobIntegrityError(`chunk ${index} failed authentication`);
  }
}
