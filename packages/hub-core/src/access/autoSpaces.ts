/**
 * Automatic Space mode (spec FR-012, FR-031; contracts/hub-access.md#automatic-mode-claim): with the owner's switch on, the first
 * client to present a valid access key for an unserved Space registers it (trust on first use), within caps.
 */

import { b64uDecode } from '@sync/transport-bluetooth/link';
import { authMessage, spaceIdBytes, type AuthEntry } from './verify';
import type { HubSettings, ServedSpaceRecord } from '../types';

export const MAX_AUTO_SPACES = 20;

export interface Claim {
  space: string;
  epoch: number;
  accessPublicKey: string;
}

/**
 * A new record for the claimed Space, or undefined if the claim must not be honored: automatic mode off, the Space is already
 * served (a claim never changes a registered key), the auto-Space cap is reached, malformed values, or the accompanying proof does
 * not verify under the claimed key (so the claimant must hold the matching private key).
 */
export async function claimAutoSpace(a: {
  settings: HubSettings;
  records: Map<string, ServedSpaceRecord>;
  claim: Claim;
  entry: AuthEntry | undefined;
  hubFingerprint: Uint8Array;
  nc: Uint8Array;
  nh: Uint8Array;
  now: number;
}): Promise<ServedSpaceRecord | undefined> {
  if (!a.settings.autoSpaces) return undefined;
  const { claim } = a;
  if (typeof claim.space !== 'string' || !Number.isInteger(claim.epoch) || claim.epoch < 0) return undefined;
  if (a.records.has(claim.space)) return undefined;
  const raw = spaceIdBytes(claim.space);
  const pub = b64uDecode(claim.accessPublicKey);
  if (!raw || !pub || pub.length !== 32) return undefined;
  let autos = 0;
  for (const r of a.records.values()) if (r.source === 'auto') autos++;
  if (autos >= MAX_AUTO_SPACES) return undefined;
  if (!a.entry || a.entry.space !== claim.space || a.entry.epoch !== claim.epoch) return undefined;
  const sig = b64uDecode(a.entry.sig);
  if (!sig || sig.length !== 64) return undefined;
  try {
    const key = await crypto.subtle.importKey('raw', pub as unknown as BufferSource, { name: 'Ed25519' }, false, ['verify']);
    const msg = authMessage({ hubFingerprint: a.hubFingerprint, nc: a.nc, nh: a.nh, space: raw, epoch: claim.epoch });
    if (!(await crypto.subtle.verify({ name: 'Ed25519' }, key, sig as unknown as BufferSource, msg as unknown as BufferSource))) return undefined;
  } catch {
    return undefined;
  }
  return { space: claim.space, source: 'auto', accessKeys: [{ epoch: claim.epoch, publicKey: pub, addedAt: a.now }], addedAt: a.now };
}
