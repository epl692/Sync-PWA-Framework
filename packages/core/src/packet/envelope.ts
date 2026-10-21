/** Data Packet envelope v1 (specs/001-sync-core/contracts/packet-envelope.md). */

import { parseClock } from '../clock/hlc';
import type { DataPacketEnvelope } from '../types';
import { b64urlDecode, b64urlEncode, canonicalBytes, CanonicalError, parseJsonBytes } from './canonical';

export const ENVELOPE_VERSION = 1;

export type EnvelopeErrorCode = 'malformed' | 'too-large';

export class EnvelopeError extends Error {
  constructor(
    readonly code: EnvelopeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EnvelopeError';
  }
}

const ID_PART_RE = /^[A-Za-z0-9_]+$/;

export type EnvelopeInit = Omit<DataPacketEnvelope, 'v' | 'id'>;

export function buildEnvelope(init: EnvelopeInit): DataPacketEnvelope {
  return { v: ENVELOPE_VERSION, id: `${init.author}:${init.seq}`, ...init };
}

/** Canonical wire bytes. Relays forward the original received bytes instead of re-encoding. */
export function encodeEnvelope(env: DataPacketEnvelope): Uint8Array {
  return canonicalBytes({
    v: env.v,
    id: env.id,
    author: env.author,
    seq: env.seq,
    space: env.space,
    clock: env.clock,
    codec: env.codec,
    body: b64urlEncode(env.body),
    sig: env.sig ? b64urlEncode(env.sig) : null,
  });
}

export interface DecodedEnvelope {
  env: DataPacketEnvelope;
  /** The exact bytes received. Store and forward these. */
  raw: Uint8Array;
  /** `v` is newer than this build understands: store, count as held and relay, but do not apply. */
  unsupportedVersion: boolean;
}

function bad(msg: string): never {
  throw new EnvelopeError('malformed', msg);
}

export function decodeEnvelope(raw: Uint8Array, maxBytes?: number): DecodedEnvelope {
  if (maxBytes !== undefined && raw.byteLength > maxBytes) {
    throw new EnvelopeError('too-large', `envelope is ${raw.byteLength} bytes (limit ${maxBytes})`);
  }
  let o: any;
  try {
    o = parseJsonBytes(raw);
  } catch (e) {
    if (e instanceof CanonicalError) bad(e.message);
    throw e;
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) bad('envelope is not an object');
  if (!Number.isInteger(o.v) || o.v < 1) bad('invalid version');
  if (typeof o.author !== 'string' || !ID_PART_RE.test(o.author)) bad('invalid author');
  if (!Number.isInteger(o.seq) || o.seq < 1) bad('invalid seq');
  if (typeof o.space !== 'string' || o.space === '') bad('invalid space');
  if (o.id !== `${o.author}:${o.seq}`) bad('id must equal author:seq');

  if (o.v > ENVELOPE_VERSION) {
    const env: DataPacketEnvelope = {
      v: o.v,
      id: o.id,
      author: o.author,
      seq: o.seq,
      space: o.space,
      clock: typeof o.clock === 'string' ? o.clock : '',
      codec: typeof o.codec === 'string' ? o.codec : '',
      body: new Uint8Array(0),
      sig: null,
    };
    return { env, raw, unsupportedVersion: true };
  }

  const clock = typeof o.clock === 'string' ? parseClock(o.clock) : null;
  if (!clock) bad('invalid clock');
  if (clock.device !== o.author) bad('clock device must equal author');
  if (typeof o.codec !== 'string' || o.codec === '') bad('invalid codec');
  if (typeof o.body !== 'string') bad('invalid body');
  if (o.sig !== null && typeof o.sig !== 'string') bad('invalid sig');
  let body: Uint8Array;
  let sig: Uint8Array | null = null;
  try {
    body = b64urlDecode(o.body);
    if (o.sig !== null) sig = b64urlDecode(o.sig);
  } catch {
    return bad('invalid base64url');
  }
  const env: DataPacketEnvelope = {
    v: o.v,
    id: o.id,
    author: o.author,
    seq: o.seq,
    space: o.space,
    clock: o.clock,
    codec: o.codec,
    body,
    sig,
  };
  return { env, raw, unsupportedVersion: false };
}
