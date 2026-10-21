/** The invite artifact (link / QR), the proof of possessing its secret, and the short authentication string. */

import { b64urlDecode, b64urlEncode } from '@sync/core';
import { concat, deviceIdFromSignPub, equalBytes, sha256, utf8, type Role, bs } from '@sync/spaces';
import { WORDS } from './words';

export interface ArtifactData {
  v: 1;
  /** invite ID */
  i: string;
  /** Space */
  s: string;
  /** secret, base64url */
  k: string;
  /** role */
  r: Role;
  /** expires at (epoch ms) */
  e: number;
  /** inviter device ID, signing key and agreement key */
  d: string;
  sp: string;
  ap: string;
}

const PREFIX = '#/join/';

export function encodeArtifact(a: ArtifactData, baseUrl: string): { url: string; qrPayload: string } {
  const url = `${baseUrl}${PREFIX}${b64urlEncode(utf8.encode(JSON.stringify(a)))}`;
  return { url, qrPayload: url };
}

/** Accepts the full link, the fragment, or the bare payload. Undefined if it is not an invite. */
export async function decodeArtifact(text: string): Promise<ArtifactData | undefined> {
  const t = text.trim();
  const at = t.indexOf(PREFIX);
  const payload = at >= 0 ? t.slice(at + PREFIX.length) : t.startsWith('#') ? t.slice(1) : t;
  let a: ArtifactData;
  try {
    a = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
  } catch {
    return undefined;
  }
  if (a?.v !== 1 || typeof a.i !== 'string' || typeof a.s !== 'string' || typeof a.k !== 'string' || typeof a.d !== 'string') return undefined;
  if (!['owner', 'editor', 'viewer'].includes(a.r) || !Number.isFinite(a.e) || typeof a.sp !== 'string' || typeof a.ap !== 'string') return undefined;
  try {
    const sp = b64urlDecode(a.sp);
    if (sp.byteLength !== 32 || b64urlDecode(a.ap).byteLength !== 32 || b64urlDecode(a.k).byteLength < 16) return undefined;
    if ((await deviceIdFromSignPub(sp)) !== a.d) return undefined; // the inviter's ID must hash its key
  } catch {
    return undefined;
  }
  return a;
}

export const secretHash = (secret: Uint8Array) => sha256(secret);

/** HMAC-SHA-256(secret, joinerSignPub || nonce): proves the joiner holds the invite secret without sending it. */
export async function proofOf(secret: Uint8Array, joinerSignPub: Uint8Array, nonce: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', bs(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, bs(concat(joinerSignPub, nonce))));
}

export const sameBytes = equalBytes;

/** Five words from the hash of both devices' signing keys: both screens show the same words. */
export async function sasOf(joinerSignPub: Uint8Array, inviterSignPub: Uint8Array): Promise<string> {
  const h = await sha256(concat(utf8.encode('sync-sas/1'), joinerSignPub, inviterSignPub));
  return [0, 1, 2, 3, 4].map((i) => WORDS[h[i]!]).join('-');
}
