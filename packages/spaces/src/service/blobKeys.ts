/**
 * Blob keys (spec 004, S-1): per-scope keys for encrypting blobs, derived from the Space's or override share's epoch key
 * so the blob engine never sees a raw epoch key. Derivation follows specs/004-blob-sync/contracts/blob-format.md#keys.
 */

import type { PacketBody } from '@sync/core';
import { base32Decode, concat, unhex, utf8 } from '../crypto/bytes';
import { hkdf, importAesKey } from '../crypto/suite';
import type { KeyAccess } from '../codec/spaceCodec';
import type { Keystore } from '../keystore/keystore';

export interface BlobWriteKeys {
  /** Raw 128-bit scope ID (Space or share). */
  scopeId: Uint8Array;
  epoch: number;
  /** 16 hex chars. */
  keyId: string;
  /** AES-256-GCM, non-extractable. */
  enc: CryptoKey;
  /** HMAC-SHA-256, non-extractable. */
  mac: CryptoKey;
}

export interface BlobReadKeys {
  scopeId: Uint8Array;
  enc: CryptoKey;
  mac: CryptoKey;
}

export interface BlobKeys {
  /** Scope for an object (Space or override share): the same rule as packet encryption. */
  scopeFor(space: string, obj: string): string;
  /** Keys for writing: the scope's current epoch. Undefined if this device holds none. Waits while this device is mid-rotation. */
  forWrite(scope: string): Promise<BlobWriteKeys | undefined>;
  /** Keys for reading a given `keyId`. Undefined if this device does not (yet) hold that epoch key. */
  forRead(scope: string, keyId: string): Promise<BlobReadKeys | undefined>;
  /** Fires when a new epoch key is stored, so blobs that failed with `no-key` can be retried. */
  onKeysChanged(handler: (scope: string) => void): () => void;
}

const SALT = new Uint8Array(32);
const INFO = utf8.encode('sync-blob/1');

export function createBlobKeys(d: { keystore: Keystore; keys: Pick<KeyAccess, 'scopeFor' | 'writeKey'> }): BlobKeys {
  const cache = new Map<string, Promise<BlobReadKeys | undefined>>();

  const derive = (scope: string, keyId: string): Promise<BlobReadKeys | undefined> => {
    const id = `${scope}:${keyId}`;
    let p = cache.get(id);
    if (!p) {
      p = (async () => {
        const raw = await d.keystore.rawKey(scope, keyId);
        if (!raw) return undefined;
        const scopeId = base32Decode(scope);
        const okm = await hkdf(raw, SALT, concat(INFO, scopeId, unhex(keyId)), 64);
        const enc = await importAesKey(okm.slice(0, 32), false);
        const mac = await globalThis.crypto.subtle.importKey('raw', okm.slice(32, 64), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        return { scopeId, enc, mac };
      })();
      cache.set(id, p);
      // a missing key is not cached: it may arrive later
      void p.then((v) => v ?? cache.delete(id));
    }
    return p;
  };

  return {
    scopeFor: (space, obj) => d.keys.scopeFor(space, { obj, type: 'blob', op: 'update', fields: {}, schemaVersion: 1 } as PacketBody),

    async forWrite(scope) {
      const w = await d.keys.writeKey(scope);
      if (!w) return undefined;
      const k = await derive(scope, w.keyId);
      return k && { ...k, epoch: w.epoch, keyId: w.keyId };
    },

    forRead: (scope, keyId) => derive(scope, keyId),

    onKeysChanged: (h) => d.keystore.onKeyStored(h),
  };
}
