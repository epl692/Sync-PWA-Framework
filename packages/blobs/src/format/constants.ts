/** Fixed parameters of `blob-aes-gcm/1` (specs/004-blob-sync/contracts/blob-format.md). Changing any of them is a new format version. */

export const FMT = 1;
/** Plaintext bytes per chunk (the last chunk may be shorter). */
export const CHUNK_BYTES = 262144;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
/** Bytes before the digest list in a manifest. */
export const MANIFEST_HEADER = 41;
/** A manifest holds at most this many chunks (the wire index fields are 32-bit, the range counts 16-bit). */
export const MAX_CHUNKS = 65535;

export const LANE_MAGIC = 0xb1;

export const GIB = 1024 * 1024 * 1024;
/** Default largest accepted blob (spec FR-012) and the most it can be configured to. */
export const DEFAULT_MAX_BLOB_BYTES = GIB;
export const ABSOLUTE_MAX_BLOB_BYTES = 16 * GIB;
