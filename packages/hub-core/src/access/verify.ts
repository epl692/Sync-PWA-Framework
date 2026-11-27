/** Membership proof verification (contracts/hub-access.md#membership-proof). The Hub holds only public keys. */

import { b64uDecode, concat } from '@sync/transport-bluetooth/link';
import type { ServedSpaceRecord } from '../types';

const AUTH_LABEL = new TextEncoder().encode('sync-hub-auth/1');
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const MAX_ENTRIES_PER_SPACE = 2;

export interface AuthEntry {
  space: string;
  epoch: number;
  sig: string;
}

/** Inverse of the 26-character base32 Space IDs (16 bytes). Null if malformed. */
export function spaceIdBytes(id: string): Uint8Array | null {
  if (!/^[A-Z2-7]{26}$/.test(id)) return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of id) {
    value = ((value << 5) | B32.indexOf(ch)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

export function authMessage(a: { hubFingerprint: Uint8Array; nc: Uint8Array; nh: Uint8Array; space: Uint8Array; epoch: number }): Uint8Array {
  const e = new Uint8Array(4);
  new DataView(e.buffer).setUint32(0, a.epoch);
  return concat(AUTH_LABEL, a.hubFingerprint, a.nc, a.nh, a.space, e);
}

async function verify(pub: Uint8Array, sig: Uint8Array, msg: Uint8Array): Promise<boolean> {
  if (pub.length !== 32 || sig.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey('raw', pub as unknown as BufferSource, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, sig as unknown as BufferSource, msg as unknown as BufferSource);
  } catch {
    return false;
  }
}

export interface MembershipResult {
  accepted: string[];
  /** Every declared Space that was not accepted. Unknown and wrongly proven Spaces are indistinguishable here (spec edge case). */
  rejected: string[];
}

/** Check each declared Space against the registered, unexpired access keys. At most 2 entries per Space are considered. */
export async function verifyMembership(a: {
  records: Iterable<ServedSpaceRecord>;
  entries: AuthEntry[];
  hubFingerprint: Uint8Array;
  nc: Uint8Array;
  nh: Uint8Array;
  now: number;
}): Promise<MembershipResult> {
  const byId = new Map<string, ServedSpaceRecord>();
  for (const r of a.records) byId.set(r.space, r);
  const bySpace = new Map<string, AuthEntry[]>();
  for (const e of a.entries) {
    if (typeof e?.space !== 'string') continue;
    const list = bySpace.get(e.space) ?? [];
    if (list.length < MAX_ENTRIES_PER_SPACE) list.push(e);
    bySpace.set(e.space, list);
  }
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const [space, list] of bySpace) {
    const rec = byId.get(space);
    const raw = spaceIdBytes(space);
    let ok = false;
    if (rec && raw) {
      for (const e of list) {
        if (!Number.isInteger(e.epoch) || e.epoch < 0) continue;
        const sig = b64uDecode(e.sig);
        if (!sig) continue;
        const keys = rec.accessKeys.filter((k) => k.epoch === e.epoch && (k.expiresAt === undefined || k.expiresAt > a.now));
        const msg = authMessage({ hubFingerprint: a.hubFingerprint, nc: a.nc, nh: a.nh, space: raw, epoch: e.epoch });
        for (const k of keys) if (await verify(k.publicKey, sig, msg)) ok = true;
        if (ok) break;
      }
    }
    (ok ? accepted : rejected).push(space);
  }
  return { accepted, rejected };
}
