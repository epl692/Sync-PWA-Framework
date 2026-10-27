/** The manifest: the immutable, content-addressed description of a blob. Its SHA-256 is the blob ID. */

import { ABSOLUTE_MAX_BLOB_BYTES, CHUNK_BYTES, DEFAULT_MAX_BLOB_BYTES, FMT, MANIFEST_HEADER, MAX_CHUNKS } from './constants';
import { b64urlEncode, concat, sha256, u32, u64 } from './bytes';

export interface Manifest {
  /** Raw 128-bit Space or share ID. */
  scopeId: Uint8Array;
  /** First 8 bytes of SHA-256(epoch key). */
  keyId: Uint8Array;
  /** Plaintext bytes, > 0. */
  size: number;
  chunkBytes: number;
  /** SHA-256 of each stored chunk (`nonce ‖ ciphertext`). */
  digests: Uint8Array[];
}

export const chunkCount = (size: number): number => Math.ceil(size / CHUNK_BYTES);

/** Plaintext length of chunk `index` of a blob of `size` bytes. */
export const plainLength = (size: number, index: number): number => Math.min(CHUNK_BYTES, size - index * CHUNK_BYTES);

export function encodeManifest(m: { scopeId: Uint8Array; keyId: Uint8Array; size: number; digests: Uint8Array[] }): Uint8Array {
  return concat(new Uint8Array([FMT]), m.scopeId, m.keyId, u64(m.size), u32(CHUNK_BYTES), u32(m.digests.length), ...m.digests);
}

export type ManifestResult = { ok: true; manifest: Manifest } | { ok: false; reason: string };

/** Parse and check well-formedness (blob-format.md). Never throws. */
export function decodeManifest(bytes: Uint8Array, limits: { maxBlobBytes?: number } = {}): ManifestResult {
  if (bytes.length < MANIFEST_HEADER) return { ok: false, reason: 'manifest too short' };
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== FMT) return { ok: false, reason: `unsupported manifest format ${bytes[0]}` };
  const size64 = v.getBigUint64(25);
  const chunkBytes = v.getUint32(33);
  const n = v.getUint32(37);
  if (chunkBytes !== CHUNK_BYTES) return { ok: false, reason: `unsupported chunk size ${chunkBytes}` };
  if (size64 <= 0n) return { ok: false, reason: 'size must be positive' };
  const max = Math.min(limits.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES, ABSOLUTE_MAX_BLOB_BYTES);
  if (size64 > BigInt(max)) return { ok: false, reason: `size exceeds the limit of ${max} bytes` };
  const size = Number(size64);
  if (n > MAX_CHUNKS) return { ok: false, reason: 'too many chunks' };
  if (n !== chunkCount(size)) return { ok: false, reason: 'chunk count does not match size' };
  if (bytes.length !== MANIFEST_HEADER + 32 * n) return { ok: false, reason: 'manifest length does not match chunk count' };
  const digests: Uint8Array[] = [];
  for (let i = 0; i < n; i++) digests.push(bytes.slice(MANIFEST_HEADER + 32 * i, MANIFEST_HEADER + 32 * (i + 1)));
  return { ok: true, manifest: { scopeId: bytes.slice(1, 17), keyId: bytes.slice(17, 25), size, chunkBytes, digests } };
}

/** base64url(SHA-256(manifest bytes)): 43 characters, unpadded. */
export async function manifestId(bytes: Uint8Array): Promise<string> {
  return b64urlEncode(await sha256(bytes));
}
