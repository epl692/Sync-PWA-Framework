/** Sync protocol messages (specs/001-sync-core/contracts/sync-protocol.md). */

import { canonicalBytes, parseJsonBytes } from '../packet/canonical';
import type { Held } from '../store/summaries';

export const PROTOCOL = { min: 1, max: 1 } as const;
/** In `hello.spaces`: "any Space you declare" (used by relays and hubs that hold opaque data for everyone). */
export const ANY_SPACE = '*';

export type Msg =
  | { t: 'hello'; protocol: { min: number; max: number }; device: string; spaces: string[]; relay: boolean; lanes?: number[] }
  | { t: 'summary'; space: string; held: Held }
  | { t: 'want'; space: string; ranges: Held; max?: number }
  | { t: 'packets'; space: string; items: string[] }
  /** `objects` is plain state (dev/test). With a SnapshotGuard it is replaced by `sealed` plus `signer` and `sig` (A-3). */
  | { t: 'snapshot'; space: string; covers: Held; objects?: unknown[]; sealed?: string; signer?: string; sig?: string; part: number; of: number }
  /** Plugin channel message (A-4). Never stored. `space` lets a relay route it ("*" = every other peer). */
  | { t: 'chan'; name: string; space: string; payload: string }
  | { t: 'ack'; space: string; ids: string[] }
  | { t: 'error'; code: string; message: string; fatal: boolean }
  | { t: 'ping' }
  | { t: 'pong' };

export type Decoded = { ok: true; msg: Msg } | { ok: true; unknown: string } | { ok: false; reason: string };

export function encodeMessage(m: Msg): Uint8Array {
  return canonicalBytes(m);
}

const isStr = (x: unknown): x is string => typeof x === 'string';
const isLanes = (x: unknown): x is number[] => Array.isArray(x) && x.every((n) => Number.isInteger(n) && n >= 0x80 && n <= 0xff);
const isHeld = (x: unknown): x is Held =>
  typeof x === 'object' &&
  x !== null &&
  Object.values(x).every(
    (iv) => Array.isArray(iv) && iv.every((p) => Array.isArray(p) && p.length === 2 && Number.isInteger(p[0]) && Number.isInteger(p[1])),
  );

/** Parse and shape-check. Unknown `t` is reported separately so callers can ignore it (forward compatibility). */
export function decodeMessage(bytes: Uint8Array, maxBytes?: number): Decoded {
  if (maxBytes !== undefined && bytes.byteLength > maxBytes) return { ok: false, reason: 'message-too-large' };
  let o: any;
  try {
    o = parseJsonBytes(bytes);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof o !== 'object' || o === null || !isStr(o.t)) return { ok: false, reason: 'malformed' };
  const bad = { ok: false as const, reason: `malformed ${o.t}` };
  switch (o.t) {
    case 'hello':
      return Number.isInteger(o.protocol?.min) &&
        Number.isInteger(o.protocol?.max) &&
        isStr(o.device) &&
        Array.isArray(o.spaces) &&
        o.spaces.every(isStr)
        ? { ok: true, msg: { t: 'hello', protocol: o.protocol, device: o.device, spaces: o.spaces, relay: o.relay !== false, ...(isLanes(o.lanes) ? { lanes: o.lanes } : {}) } }
        : bad;
    case 'summary':
      return isStr(o.space) && isHeld(o.held) ? { ok: true, msg: o } : bad;
    case 'want':
      return isStr(o.space) && isHeld(o.ranges) ? { ok: true, msg: o } : bad;
    case 'packets':
      return isStr(o.space) && Array.isArray(o.items) && o.items.every(isStr) ? { ok: true, msg: o } : bad;
    case 'snapshot':
      return isStr(o.space) && isHeld(o.covers) && (Array.isArray(o.objects) || isStr(o.sealed)) && (o.signer === undefined || isStr(o.signer)) && (o.sig === undefined || isStr(o.sig)) && Number.isInteger(o.part) && Number.isInteger(o.of) && o.part >= 0 && o.part < o.of
        ? { ok: true, msg: o }
        : bad;
    case 'chan':
      return isStr(o.name) && isStr(o.space) && isStr(o.payload) ? { ok: true, msg: o } : bad;
    case 'ack':
      return isStr(o.space) && Array.isArray(o.ids) && o.ids.every(isStr) ? { ok: true, msg: o } : bad;
    case 'error':
      return isStr(o.code) && isStr(o.message) ? { ok: true, msg: { t: 'error', code: o.code, message: o.message, fatal: o.fatal === true } } : bad;
    case 'ping':
    case 'pong':
      return { ok: true, msg: { t: o.t } };
    default:
      return { ok: true, unknown: o.t };
  }
}

/** Split `author:seq` (author never contains ':'). */
export function splitPacketId(id: string): { author: string; seq: number } | null {
  const i = id.lastIndexOf(':');
  if (i < 1) return null;
  const seq = Number(id.slice(i + 1));
  return Number.isInteger(seq) && seq > 0 ? { author: id.slice(0, i), seq } : null;
}
