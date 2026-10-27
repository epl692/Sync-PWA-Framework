/**
 * The only module in @sync/blobs that knows about @sync/spaces. It adapts `spaces.blobKeys` (S-1) to the Web Crypto
 * handles the chunk code needs; raw epoch keys never reach this package. Everything else depends on `KeyProvider`.
 */

import type { BlobKeys } from '@sync/spaces';
import { BlobKeyError } from '../types';
import type { ChunkKeys } from './chunk';

export interface WriteKeys extends ChunkKeys {
  /** Space or share ID the keys belong to. */
  scope: string;
  epoch: number;
}

export interface KeyProvider {
  /** Which scope (Space or override share) an object's blobs are encrypted under. */
  scopeFor(space: string, obj: string): string;
  /** Keys to attach with. Throws BlobKeyError when this device holds none for the scope. */
  forWrite(space: string, obj: string): Promise<WriteKeys>;
  /** Keys to decrypt a blob written under `keyId`, or undefined when this device does not (yet) hold that epoch key. */
  forRead(scope: string, keyId: string): Promise<ChunkKeys | undefined>;
  /** A new epoch key arrived: blobs that failed with `no-key` can be retried. */
  onKeysChanged(handler: (scope: string) => void): () => void;
}

export function keyProviderFrom(keys: BlobKeys): KeyProvider {
  return {
    scopeFor: (space, obj) => keys.scopeFor(space, obj),
    async forWrite(space, obj) {
      const scope = keys.scopeFor(space, obj);
      const w = await keys.forWrite(scope);
      if (!w) throw new BlobKeyError(`this device holds no key for ${scope}`);
      return { scope, epoch: w.epoch, scopeId: w.scopeId, keyId: w.keyId, enc: w.enc, mac: w.mac };
    },
    async forRead(scope, keyId) {
      const r = await keys.forRead(scope, keyId);
      return r && { scopeId: r.scopeId, keyId, enc: r.enc, mac: r.mac };
    },
    onKeysChanged: (h) => keys.onKeysChanged(h),
  };
}
