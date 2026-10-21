/**
 * DEV/TEST ONLY. Writes packet bodies as readable canonical JSON with no encryption.
 * Per Constitution Principle V this must never ship in a release; spec 002 provides the real codec.
 */
import {
  canonicalBytes,
  parseJsonBytes,
  type CodecContext,
  type DecodeResult,
  type PacketBody,
  type PayloadCodec,
} from '@sync/core';

export class PlaintextCodec implements PayloadCodec {
  readonly id = 'test-plaintext/1';

  async encode(body: PacketBody, _ctx: CodecContext): Promise<Uint8Array> {
    return canonicalBytes(body);
  }

  async decode(bytes: Uint8Array, _ctx: CodecContext): Promise<DecodeResult> {
    try {
      const o = parseJsonBytes(bytes) as PacketBody;
      if (
        typeof o !== 'object' ||
        o === null ||
        typeof o.obj !== 'string' ||
        !['create', 'update', 'delete'].includes(o.op) ||
        typeof o.type !== 'string' ||
        typeof o.fields !== 'object' ||
        o.fields === null
      ) {
        return { ok: false, reason: 'malformed' };
      }
      return { ok: true, body: { ...o, schemaVersion: o.schemaVersion ?? 1 } };
    } catch {
      return { ok: false, reason: 'malformed' };
    }
  }
}
