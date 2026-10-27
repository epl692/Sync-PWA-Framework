/**
 * Blob references: the only blob datum that lives in a packet. Pure and dependency-free so it can be imported by
 * `@sync/modules` through the `@sync/blobs/ref` subpath without pulling in crypto or storage.
 */

import { ABSOLUTE_MAX_BLOB_BYTES, DEFAULT_MAX_BLOB_BYTES } from './constants';

/** The value stored in an object field. Contains no bytes. */
export interface BlobRef {
  $blob: 1;
  /** base64url SHA-256 of the manifest (43 chars). */
  id: string;
  /** Plaintext bytes. */
  size: number;
  /** Media type, e.g. "image/jpeg". */
  type: string;
  space: string;
  /** Space ID or override share ID whose epoch key encrypted the blob. */
  scope: string;
  /** 16 hex chars: which epoch key (survives rotation). */
  keyId: string;
  /** Display name only; never used as a path. */
  name?: string;
}

export type RefResult = { ok: true; ref: BlobRef } | { ok: false; reason: string; unsupported?: boolean };

const ID = /^[A-Za-z0-9_-]{43}$/;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** 43 base64url characters carry 258 bits for a 256-bit hash: the last character's two spare bits must be zero, so each ID has one spelling. */
const isId = (s: unknown): s is string => typeof s === 'string' && ID.test(s) && (ALPHABET.indexOf(s[42]!) & 3) === 0;
const KEY_ID = /^[0-9a-f]{16}$/;
const MEDIA_TYPE = /^[\w.+-]+\/[\w.+-]+$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown, max = 128): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** Check one field value. A future `$blob` version is `unsupported` (kept and relayed, never fetched), not invalid. */
export function validateRef(value: unknown, limits: { maxBlobBytes?: number } = {}): RefResult {
  if (!isObj(value)) return { ok: false, reason: 'not an object' };
  if (value.$blob === undefined) return { ok: false, reason: 'missing $blob marker' };
  if (value.$blob !== 1) return { ok: false, reason: `unsupported blob reference version ${String(value.$blob)}`, unsupported: true };
  const max = Math.min(limits.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES, ABSOLUTE_MAX_BLOB_BYTES);
  if (!isId(value.id)) return { ok: false, reason: 'id must be the 43 base64url characters of a SHA-256 hash' };
  if (!Number.isSafeInteger(value.size) || (value.size as number) <= 0) return { ok: false, reason: 'size must be a positive integer' };
  if ((value.size as number) > max) return { ok: false, reason: `size ${value.size} exceeds the limit of ${max} bytes` };
  if (typeof value.type !== 'string' || value.type.length > 127 || !MEDIA_TYPE.test(value.type)) return { ok: false, reason: 'type must be a media type such as image/jpeg' };
  if (!nonEmpty(value.space)) return { ok: false, reason: 'space must be a non-empty string' };
  if (!nonEmpty(value.scope)) return { ok: false, reason: 'scope must be a non-empty string' };
  if (typeof value.keyId !== 'string' || !KEY_ID.test(value.keyId)) return { ok: false, reason: 'keyId must be 16 hex characters' };
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 255)) return { ok: false, reason: 'name must be a string of at most 255 characters' };
  return { ok: true, ref: value as unknown as BlobRef };
}

const MAX_DEPTH = 4;

/** Every value that carries a `$blob` marker, found at the top level, inside objects and inside lists (depth ≤ 4). Not validated. */
export function extractRefs(fieldValue: unknown): unknown[] {
  const out: unknown[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (Array.isArray(v)) {
      if (depth < MAX_DEPTH) for (const x of v) walk(x, depth + 1);
    } else if (isObj(v)) {
      if ('$blob' in v) out.push(v);
      else if (depth < MAX_DEPTH) for (const x of Object.values(v)) walk(x, depth + 1);
    }
  };
  walk(fieldValue, 0);
  return out;
}
