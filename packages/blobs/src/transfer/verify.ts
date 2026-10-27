/**
 * Receiver-side verification, in the order of blob-format.md: the manifest hashes to the blob ID and matches the
 * reference, each chunk matches its manifest digest, and only then is it stored. The AES-GCM tag is checked on open.
 * A relay can do the first two without any key.
 */

import { bytesEqual, hex, sha256 } from '../format/bytes';
import { decodeManifest, manifestId, plainLength, type Manifest } from '../format/manifest';
import { NONCE_BYTES, TAG_BYTES } from '../format/constants';
import type { BlobRef } from '../format/ref';

export type ManifestVerdict = { ok: true; manifest: Manifest } | { ok: false; reason: string };
export type ChunkVerdict = { ok: true } | { ok: false; reason: string };

export async function verifyManifest(
  ref: Pick<BlobRef, 'id' | 'size' | 'keyId'>,
  bytes: Uint8Array,
  opts: { maxBlobBytes: number; scopeId?: Uint8Array },
): Promise<ManifestVerdict> {
  if ((await manifestId(bytes)) !== ref.id) return { ok: false, reason: 'manifest does not hash to the blob ID' };
  const d = decodeManifest(bytes, { maxBlobBytes: opts.maxBlobBytes });
  if (!d.ok) return { ok: false, reason: d.reason };
  if (hex(d.manifest.keyId) !== ref.keyId) return { ok: false, reason: 'manifest key ID differs from the reference' };
  if (d.manifest.size !== ref.size) return { ok: false, reason: 'manifest size differs from the reference' };
  if (opts.scopeId && !bytesEqual(opts.scopeId, d.manifest.scopeId)) return { ok: false, reason: 'manifest scope differs from the reference' };
  return { ok: true, manifest: d.manifest };
}

/** Check one stored chunk (`nonce ‖ ciphertext ‖ tag`) against the manifest. */
export async function verifyChunk(m: Manifest, index: number, stored: Uint8Array): Promise<ChunkVerdict> {
  if (!Number.isInteger(index) || index < 0 || index >= m.digests.length) return { ok: false, reason: `chunk index ${index} is out of range` };
  if (stored.length !== NONCE_BYTES + plainLength(m.size, index) + TAG_BYTES) return { ok: false, reason: `chunk ${index} has the wrong length` };
  if (!bytesEqual(await sha256(stored), m.digests[index]!)) return { ok: false, reason: `chunk ${index} does not match its digest` };
  return { ok: true };
}
