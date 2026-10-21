/** Extension points (specs/001-sync-core/contracts/extension-points.ts). */

import type { DataPacketEnvelope, PacketBody } from '../types';

export interface CodecContext {
  space: string;
  author: string;
}

export type DecodeResult =
  | { ok: true; body: PacketBody }
  | { ok: false; reason: 'unknown-codec' | 'missing-key' | 'malformed' };

export interface PayloadCodec {
  readonly id: string;
  encode(body: PacketBody, ctx: CodecContext): Promise<Uint8Array>;
  decode(bytes: Uint8Array, ctx: CodecContext): Promise<DecodeResult>;
}

export type ValidationPhase = 'send' | 'apply';

export type ValidationResult =
  | { verdict: 'accept' }
  | { verdict: 'reject'; reason: string }
  | { verdict: 'defer'; reason: string };

export interface ValidatorContext {
  now(): number;
  existing?: unknown;
}

export interface PacketValidator {
  readonly id: string;
  readonly phases: readonly ValidationPhase[];
  validate(
    phase: ValidationPhase,
    envelope: DataPacketEnvelope,
    body: PacketBody | undefined,
    ctx: ValidatorContext,
  ): Promise<ValidationResult> | ValidationResult;
}
