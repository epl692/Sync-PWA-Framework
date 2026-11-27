/** Hub identity: a long-lived Ed25519 key that signs the link handshake (research R-06). Never content authority. */

import { fingerprintBytes, fingerprintGroups, fingerprintWords, type HubSigner } from '@sync/transport-bluetooth/link';
import type { HubStore } from './store/types';

export interface HubIdentity extends HubSigner {
  /** SHA-256 of the public key. */
  fingerprint: Uint8Array;
  /** 8 groups of 4 base32 characters. */
  fingerprintText: string;
  /** 4 words, easy to compare aloud. */
  words: string[];
}

const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
const bs = (u: Uint8Array) => u as unknown as BufferSource;

async function fromSeed(seed: Uint8Array): Promise<HubIdentity> {
  const subtle = globalThis.crypto.subtle;
  const pkcs8 = new Uint8Array(PKCS8_PREFIX.length + 32);
  pkcs8.set(PKCS8_PREFIX);
  pkcs8.set(seed, PKCS8_PREFIX.length);
  const extractable = await subtle.importKey('pkcs8', bs(pkcs8), { name: 'Ed25519' }, true, ['sign']);
  const x = (await subtle.exportKey('jwk', extractable)).x!;
  const b64 = x.replace(/-/g, '+').replace(/_/g, '/');
  const publicKey = Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
  const priv = await subtle.importKey('pkcs8', bs(pkcs8), { name: 'Ed25519' }, false, ['sign']);
  const fingerprint = await fingerprintBytes(publicKey);
  return {
    publicKey,
    fingerprint,
    fingerprintText: fingerprintGroups(fingerprint),
    words: fingerprintWords(fingerprint),
    sign: async (m) => new Uint8Array(await subtle.sign({ name: 'Ed25519' }, priv, bs(m))),
  };
}

/** Load the Hub key from the store, or create and save one. A stored seed of the wrong length is not trusted. */
export async function loadOrCreateHubIdentity(store: HubStore): Promise<HubIdentity> {
  let seed = await store.loadHubKey();
  if (!seed || seed.length !== 32) {
    seed = globalThis.crypto.getRandomValues(new Uint8Array(32));
    await store.saveHubKey(seed);
  }
  return fromSeed(seed);
}
