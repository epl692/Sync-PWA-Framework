/** Spec 005 S-2: Hub access for the Spaces layer: serve/link code export and the Bluetooth transport's proof provider. */

import { base32Decode, concat, utf8 } from '../crypto/bytes';
import { signBytes } from '../crypto/suite';
import { deriveHubAccess, hubAuthMessage, proveHubChallenge, type HubAccessKey } from '../hubAccess';
import { encodeHubCode } from '../hubCodes';
import type { Keystore } from '../keystore/keystore';

export interface HubProofs {
  /** Spaces this device can prove membership for, with the highest epoch it holds. */
  spaces(): Promise<Array<{ space: string; epoch: number }>>;
  /** Sign the Hub challenge for one Space and epoch with that epoch's derived access key. */
  proveSpace(a: { space: string; epoch: number; hubFingerprint: Uint8Array; nc: Uint8Array; nh: Uint8Array }): Promise<Uint8Array>;
  /** Sign the session binding with the device signing key. */
  proveDevice(a: { hubFingerprint: Uint8Array; nc: Uint8Array; nh: Uint8Array }): Promise<{ device: string; sig: Uint8Array; name: string }>;
  /** Access public key, used only for the optional automatic-mode claim. */
  accessPublic(space: string, epoch: number): Promise<Uint8Array>;
}

export interface HubAccess {
  readonly proofs: HubProofs;
  /**
   * Export a serve code (public key only) or, with `link: true`, a link code that also carries the access secret.
   * Needs a Space this device holds keys for, at its latest epoch.
   */
  exportCode(space: string, opts?: { link?: boolean; name?: boolean; expiresAt?: number }): Promise<string>;
}

export const HUB_DEVICE_LABEL = 'sync-hub-dev/1';

export function createHubAccess(d: { keystore: Keystore; now?: () => number; spaceName?: (space: string) => Promise<string | undefined> }): HubAccess {
  const now = d.now ?? (() => Date.now());

  const latest = async (space: string) => {
    const held = await d.keystore.epochs(space);
    if (!held.length) return undefined;
    return held.reduce((a, b) => (b.epoch > a.epoch ? b : a));
  };

  const keyFor = async (space: string, epoch: number): Promise<HubAccessKey | undefined> => {
    const held = (await d.keystore.epochs(space)).find((h) => h.epoch === epoch);
    if (!held) return undefined;
    const raw = await d.keystore.rawKey(space, held.keyId);
    if (!raw) return undefined;
    return deriveHubAccess(raw, base32Decode(space), epoch);
  };

  const proofs: HubProofs = {
    async spaces() {
      const out: Array<{ space: string; epoch: number }> = [];
      for (const space of await d.keystore.spaces()) {
        const l = await latest(space);
        if (l) out.push({ space, epoch: l.epoch });
      }
      return out;
    },
    async proveSpace(a) {
      const k = await keyFor(a.space, a.epoch);
      if (!k) throw new Error('no key for that Space and epoch');
      return proveHubChallenge(k, hubAuthMessage({ hubFingerprint: a.hubFingerprint, nc: a.nc, nh: a.nh, space: base32Decode(a.space), epoch: a.epoch }));
    },
    async proveDevice(a) {
      const dev = d.keystore.requireDevice();
      const sig = await signBytes(dev.signPriv, concat(utf8.encode(HUB_DEVICE_LABEL), a.hubFingerprint, a.nc, a.nh));
      return { device: dev.deviceId, sig, name: dev.displayName ?? 'device' };
    },
    async accessPublic(space, epoch) {
      const k = await keyFor(space, epoch);
      if (!k) throw new Error('no key for that Space and epoch');
      return k.publicRaw;
    },
  };

  return {
    proofs,
    async exportCode(space, opts = {}) {
      const l = await latest(space);
      if (!l) throw new Error('this device holds no key for that Space');
      const k = await keyFor(space, l.epoch);
      if (!k) throw new Error('this device holds no key for that Space');
      const name = opts.name ? await d.spaceName?.(space) : undefined;
      return encodeHubCode({
        v: 1,
        kind: opts.link ? 'link' : 'serve',
        space,
        epoch: l.epoch,
        accessPublic: k.publicRaw,
        ...(opts.link ? { accessSecret: k.seed } : {}),
        ...(name ? { name } : {}),
        createdAt: now(),
        ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
      });
    },
  };
}
