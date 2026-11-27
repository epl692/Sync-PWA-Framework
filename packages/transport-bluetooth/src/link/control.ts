/** Control messages (inner kind 0x00), contracts/bluetooth-link.md#control-messages. Unknown `t` values are ignored by receivers. */

import { utf8, utf8d } from './bytes';

export interface AuthSpace {
  space: string;
  epoch: number;
  /** base64url Ed25519 signature (membership proof). */
  sig: string;
}

export type ControlMessage =
  | {
      t: 'auth';
      device: string;
      /** base64url Ed25519 public key of the device; `device` must equal the self-certifying ID of this key. */
      devicePub: string;
      devSig: string;
      name: string;
      spaces: AuthSpace[];
      claim?: Array<{ space: string; epoch: number; accessPublicKey: string }>;
    }
  | { t: 'auth-ok'; state: 'trusted'; accepted: string[]; rejected: string[] }
  | { t: 'pending' }
  | { t: 'reject'; code: 'not-served' | 'blocked' | 'denied' | 'busy'; retryMs?: number }
  | { t: 'probe-result'; received: number[]; notify: number }
  | { t: 'ping' }
  | { t: 'pong' }
  /** A message was lost: both sides restart the sync handshake (hello and summaries) so nothing stays missing. */
  | { t: 'resync'; id: number }
  | { t: 'resync-ack'; id: number }
  | { t: 'bye'; reason?: string }
  | { t: 'error'; code: string; fatal?: boolean; message?: string };

export const INNER_CONTROL = 0x00;
export const INNER_CORE = 0x01;

export function encodeControl(msg: ControlMessage): Uint8Array {
  const json = utf8.encode(JSON.stringify(msg));
  const out = new Uint8Array(json.length + 1);
  out[0] = INNER_CONTROL;
  out.set(json, 1);
  return out;
}

export function encodeCore(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + 1);
  out[0] = INNER_CORE;
  out.set(bytes, 1);
  return out;
}

export type Inner = { kind: 'control'; msg: { t: string } & Record<string, unknown> } | { kind: 'core'; bytes: Uint8Array };

/** Null for an empty, unknown-kind, or unparseable inner message. A control message of an unknown `t` is returned as is. */
export function decodeInner(b: Uint8Array): Inner | null {
  if (b.length < 1) return null;
  if (b[0] === INNER_CORE) return { kind: 'core', bytes: b.slice(1) };
  if (b[0] !== INNER_CONTROL) return null;
  try {
    const o = JSON.parse(utf8d.decode(b.slice(1))) as unknown;
    if (!o || typeof o !== 'object' || typeof (o as { t?: unknown }).t !== 'string') return null;
    return { kind: 'control', msg: o as { t: string } & Record<string, unknown> };
  } catch {
    return null;
  }
}
