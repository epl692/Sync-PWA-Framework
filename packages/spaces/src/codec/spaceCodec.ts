/**
 * `aes-gcm-space/1`: the encrypting payload codec (contracts/crypto-envelope.md).
 *
 * body bytes = header(29) || nonce(12) || ciphertext+tag
 * header     = fmt(1)=0x01 || scopeId(16) || epoch(u32) || keyId(8)
 * AAD        = canonical({v,id,author,seq,space,clock,codec}) || header
 *
 * The header is readable by relays (FR-006). The signature covers it, and the AAD binds the
 * ciphertext to its envelope, so a body cannot be transplanted into another packet.
 */

import {
  canonicalBytes,
  parseJsonBytes,
  base32,
  type CodecContext,
  type DecodeResult,
  type PacketBody,
  type PayloadCodec,
} from '@sync/core';
import { base32Decode, concat, hex, randomBytes, readU32be, u32be, unhex, utf8 } from '../crypto/bytes';
import { aesOpen, aesSeal } from '../crypto/suite';

export const SPACE_CODEC_ID = 'aes-gcm-space/1';
export const HEADER_BYTES = 29;
const FMT = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** Hard stop for random 96-bit nonces under one key (research R-04). Auto-rotation triggers at half of this. */
export const MAX_ENCRYPTIONS_PER_KEY = 2 ** 32 - 1;
export const ROTATE_AT_ENCRYPTIONS = 2 ** 31;

export interface CodecHeader {
  fmt: number;
  scope: string;
  epoch: number;
  keyId: string; // hex
}

/** Read the readable header without decrypting. Undefined if the bytes are too short or not this format. */
export function parseHeader(bytes: Uint8Array): CodecHeader | undefined {
  if (bytes.byteLength < HEADER_BYTES || bytes[0] !== FMT) return undefined;
  return { fmt: bytes[0], scope: base32(bytes.slice(1, 17)), epoch: readU32be(bytes, 17), keyId: hex(bytes.slice(21, 29)) };
}

export function buildHeader(scope: string, epoch: number, keyIdHex: string): Uint8Array {
  return concat(new Uint8Array([FMT]), base32Decode(scope), u32be(epoch), unhex(keyIdHex));
}

export class NoWriteKeyError extends Error {
  readonly code = 'no-write-key';
  constructor(scope: string) {
    super(`this device holds no key for scope ${scope}; it cannot write there`);
    this.name = 'NoWriteKeyError';
  }
}

/** What the codec needs from the keystore and the authority state. */
export interface KeyAccess {
  /** Which scope (the Space, or an override share) a packet for this object is encrypted under. */
  scopeFor(space: string, body: PacketBody): string;
  /** The key new packets in this scope are written with. */
  writeKey(scope: string): Promise<{ epoch: number; keyId: string; key: CryptoKey } | undefined>;
  readKey(scope: string, keyId: string): Promise<CryptoKey | undefined>;
  /** Called after each encryption so nonce use can be counted. Resolves the new total. */
  used(scope: string, keyId: string): Promise<number>;
}

const envelopeAad = (e: NonNullable<CodecContext['envelope']>, space: string, author: string) =>
  canonicalBytes({ v: e.v, id: e.id, author, seq: e.seq, space, clock: e.clock, codec: e.codec } as never);

function isBody(o: unknown): o is PacketBody {
  const b = o as PacketBody;
  return (
    typeof b === 'object' &&
    b !== null &&
    typeof b.obj === 'string' &&
    (b.op === 'create' || b.op === 'update' || b.op === 'delete') &&
    typeof b.type === 'string' &&
    typeof b.fields === 'object' &&
    b.fields !== null &&
    !Array.isArray(b.fields)
  );
}

export class SpaceCodec implements PayloadCodec {
  readonly id = SPACE_CODEC_ID;

  /** `nonce` is for known-answer tests only; production always draws 96 fresh random bits. */
  constructor(
    private readonly keys: KeyAccess,
    private readonly opts: { nonce?: () => Uint8Array } = {},
  ) {}

  async encode(body: PacketBody, ctx: CodecContext): Promise<Uint8Array> {
    if (!ctx.envelope) throw new Error('aes-gcm-space/1 needs the envelope context');
    const scope = this.keys.scopeFor(ctx.space, body);
    const wk = await this.keys.writeKey(scope);
    if (!wk) throw new NoWriteKeyError(scope);
    if ((await this.keys.used(scope, wk.keyId)) > MAX_ENCRYPTIONS_PER_KEY) throw new Error('key exhausted: rotate before writing again');
    const header = buildHeader(scope, wk.epoch, wk.keyId);
    const nonce = this.opts.nonce ? this.opts.nonce() : randomBytes(NONCE_BYTES);
    const aad = concat(envelopeAad(ctx.envelope, ctx.space, ctx.author), header);
    const ct = await aesSeal(wk.key, nonce, utf8.encode(JSON.stringify(body)), aad);
    return concat(header, nonce, ct);
  }

  async decode(bytes: Uint8Array, ctx: CodecContext): Promise<DecodeResult> {
    const h = parseHeader(bytes);
    if (!h) return { ok: false, reason: bytes.byteLength >= 1 && bytes[0] !== FMT ? 'unknown-codec' : 'malformed' };
    if (bytes.byteLength < HEADER_BYTES + NONCE_BYTES + TAG_BYTES || !ctx.envelope) return { ok: false, reason: 'malformed' };
    const key = await this.keys.readKey(h.scope, h.keyId);
    if (!key) return { ok: false, reason: 'missing-key' };
    const aad = concat(envelopeAad(ctx.envelope, ctx.space, ctx.author), bytes.slice(0, HEADER_BYTES));
    const pt = await aesOpen(key, bytes.slice(HEADER_BYTES, HEADER_BYTES + NONCE_BYTES), bytes.slice(HEADER_BYTES + NONCE_BYTES), aad);
    if (!pt) return { ok: false, reason: 'malformed' };
    try {
      const o = parseJsonBytes(pt);
      if (!isBody(o)) return { ok: false, reason: 'malformed' };
      return { ok: true, body: { ...o, schemaVersion: (o as PacketBody).schemaVersion ?? 1 } };
    } catch {
      return { ok: false, reason: 'malformed' };
    }
  }
}
