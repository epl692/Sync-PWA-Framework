import { canonicalString } from '../packet/canonical';
import type { SpaceId } from '../types';
import type { ObjectCache } from './cache';

/**
 * Canonical hash of a Space's complete object state, tombstones included. Two peers holding the same
 * packet set must produce the same hash (SC-004).
 */
export async function stateHash(cache: ObjectCache, space: SpaceId): Promise<string> {
  const objs = [...cache.all()].filter((o) => o.space === space).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const bytes = new TextEncoder().encode(canonicalString(objs));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
