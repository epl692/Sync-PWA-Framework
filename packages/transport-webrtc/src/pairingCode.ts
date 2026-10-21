/**
 * Pairing codes for manual signaling (specs/001-sync-core/contracts/webrtc-pairing.ts).
 * A code is "SP1." + base64url(deflate-raw(JSON payload) + CRC32), short enough for a QR code, and
 * safe to read aloud or paste. The CRC catches typos; it is not a security feature.
 */

import { b64urlDecode, b64urlEncode, crc32 } from '@sync/core';

export type PairingCode = string;

export interface PairingPayload {
  ver: 1;
  kind: 'offer' | 'answer';
  /** Complete (non-trickle) session description, candidates included. */
  sdp: string;
  /** Random; an answer carries its offer's nonce. */
  nonce: string;
  /** Epoch ms. */
  expiresAt: number;
}

export type PairingErrorCode = 'malformed' | 'expired' | 'reused' | 'mismatch' | 'timeout' | 'unreachable';

export class PairingError extends Error {
  constructor(
    readonly code: PairingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PairingError';
  }
}

const PREFIX = 'SP1.';

async function pipe(bytes: Uint8Array, stream: { writable: WritableStream<Uint8Array>; readable: ReadableStream<Uint8Array> }) {
  const w = stream.writable.getWriter();
  void w.write(bytes).catch(() => undefined);
  void w.close().catch(() => undefined);
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

export async function encodePairing(p: PairingPayload): Promise<PairingCode> {
  const json = new TextEncoder().encode(JSON.stringify(p));
  const packed = await pipe(json, new CompressionStream('deflate-raw') as never);
  const out = new Uint8Array(packed.length + 4);
  out.set(packed);
  new DataView(out.buffer).setUint32(packed.length, crc32(json));
  return PREFIX + b64urlEncode(out);
}

/** Parse and check a code. Throws PairingError('malformed') or ('expired'). */
export async function decodePairing(code: PairingCode, now: number): Promise<PairingPayload> {
  const text = code.trim();
  if (!text.startsWith(PREFIX)) throw new PairingError('malformed', 'not a pairing code');
  let json: Uint8Array;
  let expectCrc: number;
  try {
    const raw = b64urlDecode(text.slice(PREFIX.length));
    if (raw.length < 5) throw new Error('too short');
    expectCrc = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(raw.length - 4);
    json = await pipe(raw.subarray(0, raw.length - 4), new DecompressionStream('deflate-raw') as never);
  } catch {
    throw new PairingError('malformed', 'the pairing code is damaged or incomplete');
  }
  if (crc32(json) !== expectCrc) throw new PairingError('malformed', 'the pairing code has a typo or is incomplete');
  let p: PairingPayload;
  try {
    p = JSON.parse(new TextDecoder().decode(json));
  } catch {
    throw new PairingError('malformed', 'the pairing code is damaged');
  }
  if (
    p?.ver !== 1 ||
    (p.kind !== 'offer' && p.kind !== 'answer') ||
    typeof p.sdp !== 'string' ||
    typeof p.nonce !== 'string' ||
    !Number.isFinite(p.expiresAt)
  ) {
    throw new PairingError('malformed', 'unsupported pairing code');
  }
  if (now > p.expiresAt) throw new PairingError('expired', 'the pairing code has expired; create a new one');
  return p;
}

/** Remembers consumed codes so each works once. */
export class PairingLedger {
  private used = new Set<string>();

  has(key: string): boolean {
    return this.used.has(key);
  }

  consume(key: string): void {
    if (this.used.has(key)) throw new PairingError('reused', 'this pairing code was already used');
    this.used.add(key);
  }
}
