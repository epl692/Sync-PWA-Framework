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
  /** The exact received (or just encoded) envelope bytes, so signatures can be checked over unknown extra fields (A-7). */
  raw?: Uint8Array;
  /** Where the packet came from: 'local', or `${transportId}:${peerId}` (A-7). */
  source?: string;
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

/** Fills `envelope.sig` for locally authored packets (A-1). `bytes` is the canonical envelope with `sig: null`. */
export interface PacketSigner {
  readonly id: string;
  sign(bytes: Uint8Array, ctx: { space: string; author: string }): Promise<Uint8Array>;
}

/** Seals and authenticates snapshot parts so transports never see plaintext state and forged state is refused (A-3). */
export interface SnapshotGuard {
  /** Seal a group of stored objects of one Space into opaque bytes. */
  seal(space: string, objects: unknown[]): Promise<Uint8Array>;
  open(space: string, bytes: Uint8Array): Promise<{ ok: true; objects: unknown[] } | { ok: false; reason: 'missing-key' | 'malformed' }>;
  /** Sign the canonical bytes of the snapshot message (with `sig: null`). */
  sign(space: string, canonical: Uint8Array): Promise<{ signer: string; sig: Uint8Array }>;
  verify(
    space: string,
    signer: string | undefined,
    canonical: Uint8Array,
    sig: Uint8Array | undefined,
  ): Promise<{ accept: true } | { accept: false; reason: string }>;
}

/** True for objects whose packets must never be folded into a snapshot or deleted by compaction (A-6). */
export type CompactionPin = (type: string, obj: string) => boolean;
