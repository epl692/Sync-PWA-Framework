/** Connects the codec to the keystore and the authority state (which scope and which key to write with). */

import type { PacketBody } from '@sync/core';
import type { AuthorityHub } from '../authority/hub';
import { SYS_PREFIX } from '../authority/types';
import { ROTATE_AT_ENCRYPTIONS, type KeyAccess } from '../codec/spaceCodec';
import type { Keystore } from '../keystore/keystore';

export interface KeyAccessDeps {
  keystore: Keystore;
  hub: AuthorityHub;
  /** The key used this many times: time to rotate (research R-04). */
  onKeyWornOut?: (scope: string) => void;
}

/**
 * Which key new packets use (research R-09): among the keys this device holds for the scope, the highest epoch
 * that is not beyond the scope's current epoch in the authority state. A key that was generated for a rotation
 * but has not been published yet is therefore never used early, and a key we have not received yet is skipped.
 */
export function createKeyAccess(d: KeyAccessDeps): KeyAccess {
  return {
    scopeFor(space: string, body: PacketBody): string {
      if (body.type.startsWith(SYS_PREFIX)) return space;
      return d.hub.authority(space).shareOfObj(body.obj)?.id ?? space;
    },

    async writeKey(scope) {
      const held = await d.keystore.epochs(scope);
      if (!held.length) return undefined;
      const space = scope; // epochs are looked up on the Space authority; a share scope is found below
      let auth = d.hub.authority(space);
      if (!auth.epochs(scope).length) {
        for (const s of d.hub.spaces()) {
          if (d.hub.authority(s).share(scope)) {
            auth = d.hub.authority(s);
            break;
          }
        }
      }
      const cur = auth.currentEpoch(scope);
      let usable = cur ? held.filter((h) => h.epoch <= cur.epoch) : held;
      if (!usable.length) usable = held;
      const top = Math.max(...usable.map((h) => h.epoch));
      const atTop = usable.filter((h) => h.epoch === top);
      const pick = atTop.find((h) => h.keyId === cur?.keyId) ?? atTop[0]!;
      const key = await d.keystore.aesKey(scope, pick.keyId);
      return key ? { epoch: pick.epoch, keyId: pick.keyId, key } : undefined;
    },

    readKey: (scope, keyId) => d.keystore.aesKey(scope, keyId),

    async used(scope, keyId) {
      const n = await d.keystore.bumpCounter(scope, keyId);
      if (n === ROTATE_AT_ENCRYPTIONS) d.onKeyWornOut?.(scope);
      return n;
    },
  };
}
