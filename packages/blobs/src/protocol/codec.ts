/** Lane message codec for `blob/1` (contracts/blob-protocol.md). Decoding is bounds-checked and never throws. */

import { LANE_MAGIC } from '../format/constants';
import { b64urlDecode, b64urlEncode, utf8, utf8d } from '../format/bytes';

export type RejectReason = 'quota' | 'too-large' | 'space' | 'busy' | 'unsupported';
export type Range = [number, number];

export type LaneMsg =
  | { type: 'hello'; v: number; window: number; maxChunks: number; serve: boolean }
  | { type: 'offer'; space: string; id: string; size: number }
  | { type: 'get'; id: string; manifest: boolean; space: string; ranges: Range[] }
  | { type: 'manifest'; id: string; manifest: Uint8Array }
  | { type: 'chunk'; id: string; index: number; stored: Uint8Array }
  | { type: 'miss'; id: string; ranges: Range[] }
  | { type: 'stored'; id: string }
  | { type: 'reject'; id: string; reason: RejectReason }
  | { type: 'cancel'; id: string };

export type Decoded = { ok: true; msg: LaneMsg } | { ok: true; unknown: number } | { ok: false; reason: string };

export const MAX_RANGES = 4096;
const MAX_JSON = 4096;
const REASONS: ReadonlySet<string> = new Set(['quota', 'too-large', 'space', 'busy', 'unsupported']);

const T = { hello: 1, offer: 2, get: 3, manifest: 4, chunk: 5, miss: 6, stored: 7, reject: 8, cancel: 9 } as const;

const idToRaw = (id: string): Uint8Array => b64urlDecode(id);
const rawToId = (raw: Uint8Array): string => b64urlEncode(raw);

function frame(type: number, ...parts: Uint8Array[]): Uint8Array {
  let n = 2;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  out[0] = LANE_MAGIC;
  out[1] = type;
  let o = 2;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
const json = (o: unknown): Uint8Array => utf8.encode(JSON.stringify(o));
const u16 = (n: number): Uint8Array => Uint8Array.of(n >>> 8, n & 0xff);
const u32 = (n: number): Uint8Array => Uint8Array.of(n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);

function rangesBytes(r: Range[]): Uint8Array {
  const out = new Uint8Array(r.length * 8);
  const v = new DataView(out.buffer);
  r.forEach(([lo, hi], i) => {
    v.setUint32(i * 8, lo);
    v.setUint32(i * 8 + 4, hi);
  });
  return out;
}

export function encodeMessage(m: LaneMsg): Uint8Array {
  switch (m.type) {
    case 'hello':
      return frame(T.hello, json({ v: m.v, window: m.window, maxChunks: m.maxChunks, serve: m.serve }));
    case 'offer':
      return frame(T.offer, json({ space: m.space, id: m.id, size: m.size }));
    case 'get': {
      const space = utf8.encode(m.space);
      return frame(T.get, idToRaw(m.id), Uint8Array.of(m.manifest ? 1 : 0, space.length), space, u16(m.ranges.length), rangesBytes(m.ranges));
    }
    case 'manifest':
      return frame(T.manifest, idToRaw(m.id), m.manifest);
    case 'chunk':
      return frame(T.chunk, idToRaw(m.id), u32(m.index), m.stored);
    case 'miss':
      return frame(T.miss, idToRaw(m.id), u16(m.ranges.length), rangesBytes(m.ranges));
    case 'stored':
      return frame(T.stored, idToRaw(m.id));
    case 'reject':
      return frame(T.reject, json({ id: m.id, reason: m.reason }));
    case 'cancel':
      return frame(T.cancel, idToRaw(m.id));
  }
}

const bad = (reason: string): Decoded => ({ ok: false, reason });
const ID_RE = /^[A-Za-z0-9_-]{43}$/;
/** A blob ID is the base64url of 32 bytes: reject spellings that do not round-trip (the last character carries two spare bits). */
const isId = (s: unknown): s is string => typeof s === 'string' && ID_RE.test(s) && b64urlEncode(b64urlDecode(s)) === s;
const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;

function readRanges(v: DataView, at: number, n: number): Range[] | undefined {
  if (n > MAX_RANGES || at + n * 8 !== v.byteLength) return undefined;
  const out: Range[] = [];
  for (let i = 0; i < n; i++) {
    const lo = v.getUint32(at + i * 8);
    const hi = v.getUint32(at + i * 8 + 4);
    if (lo > hi) return undefined;
    out.push([lo, hi]);
  }
  return out;
}

function parseJson(bytes: Uint8Array): Record<string, unknown> | undefined {
  if (bytes.length > MAX_JSON) return undefined;
  try {
    const o = JSON.parse(utf8d.decode(bytes));
    return typeof o === 'object' && o !== null && !Array.isArray(o) ? (o as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function decodeInner(bytes: Uint8Array): Decoded {
  if (bytes.length < 2 || bytes[0] !== LANE_MAGIC) return bad('not a blob lane message');
  const type = bytes[1]!;
  const body = bytes.subarray(2);
  const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const id = (): string | undefined => (body.length >= 32 ? rawToId(body.subarray(0, 32)) : undefined);
  switch (type) {
    case T.hello: {
      const o = parseJson(body);
      if (!o || !isInt(o.v) || !isInt(o.window) || !isInt(o.maxChunks) || typeof o.serve !== 'boolean') return bad('malformed hello');
      return { ok: true, msg: { type: 'hello', v: o.v, window: o.window, maxChunks: o.maxChunks, serve: o.serve } };
    }
    case T.offer: {
      const o = parseJson(body);
      if (!o || typeof o.space !== 'string' || !isId(o.id) || !isInt(o.size) || o.size <= 0) return bad('malformed offer');
      return { ok: true, msg: { type: 'offer', space: o.space, id: o.id, size: o.size } };
    }
    case T.get: {
      const i = id();
      if (!i || body.length < 32 + 2 + 2) return bad('malformed get');
      const flags = body[32]!;
      const spaceLen = body[33]!;
      const at = 34 + spaceLen;
      if (body.length < at + 2) return bad('malformed get');
      const space = utf8d.decode(body.subarray(34, at));
      const ranges = readRanges(v, at + 2, v.getUint16(at));
      return ranges ? { ok: true, msg: { type: 'get', id: i, manifest: (flags & 1) === 1, space, ranges } } : bad('malformed get ranges');
    }
    case T.manifest: {
      const i = id();
      return i && body.length > 32 ? { ok: true, msg: { type: 'manifest', id: i, manifest: body.slice(32) } } : bad('malformed manifest');
    }
    case T.chunk: {
      const i = id();
      return i && body.length > 36 ? { ok: true, msg: { type: 'chunk', id: i, index: v.getUint32(32), stored: body.slice(36) } } : bad('malformed chunk');
    }
    case T.miss: {
      const i = id();
      if (!i || body.length < 34) return bad('malformed miss');
      const ranges = readRanges(v, 34, v.getUint16(32));
      return ranges ? { ok: true, msg: { type: 'miss', id: i, ranges } } : bad('malformed miss ranges');
    }
    case T.stored:
    case T.cancel: {
      const i = id();
      return i && body.length === 32 ? { ok: true, msg: { type: type === T.stored ? 'stored' : 'cancel', id: i } } : bad('malformed id message');
    }
    case T.reject: {
      const o = parseJson(body);
      if (!o || !isId(o.id) || typeof o.reason !== 'string' || !REASONS.has(o.reason)) return bad('malformed reject');
      return { ok: true, msg: { type: 'reject', id: o.id, reason: o.reason as RejectReason } };
    }
    default:
      return { ok: true, unknown: type };
  }
}

/** Parse one lane message. Unknown types come back as `{ok: true, unknown}` so callers can ignore them. Never throws. */
export function decodeMessage(bytes: Uint8Array): Decoded {
  try {
    return decodeInner(bytes);
  } catch {
    return bad('malformed message');
  }
}
