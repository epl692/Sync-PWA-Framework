import type { PacketSigner } from '@sync/core';
import type { Keystore } from '../keystore/keystore';
import { signBytes } from './suite';

export const SIGNATURE_ALG = 'ed25519/1';

/** Signs the canonical envelope (sig = null) with this install's device key. */
export function createSigner(keystore: Keystore): PacketSigner {
  return {
    id: SIGNATURE_ALG,
    async sign(bytes) {
      return signBytes(keystore.requireDevice().signPriv, bytes);
    },
  };
}
