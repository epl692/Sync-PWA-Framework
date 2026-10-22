/**
 * Extension points defined by spec 001 and filled by later specs (FR-010).
 * 002 provides an encrypting/signing codec and signature/role validators.
 * 003 provides schema validators.
 */

import type { DataPacketEnvelope, PacketBody } from './public-api';

export interface CodecContext {
  space: string;
  author: string;
}

export type DecodeResult =
  | { ok: true; body: PacketBody }
  /** Cannot decode now (unknown codec, missing key). The packet is parked, stored and relayed. */
  | { ok: false; reason: 'unknown-codec' | 'missing-key' | 'malformed' };

export interface PayloadCodec {
  /** Written into envelope.codec. Version it: "aes-gcm-space/1". */
  readonly id: string;
  encode(body: PacketBody, ctx: CodecContext): Promise<Uint8Array>;
  decode(bytes: Uint8Array, ctx: CodecContext): Promise<DecodeResult>;
}

export type ValidationPhase = 'send' | 'apply';

export type ValidationResult =
  | { verdict: 'accept' }
  /** Discard this packet only and report it. Never throws for the batch. */
  | { verdict: 'reject'; reason: string }
  /** Keep (store, count as held, relay) but don't apply yet; retried on revalidate(). */
  | { verdict: 'defer'; reason: string };

export interface ValidatorContext {
  now(): number;
  /** Exact envelope bytes (added by spec 002 A-7), so signatures can be checked over unknown extra fields. */
  raw?: Uint8Array;
  /** 'local' or `${transportId}:${peerId}` (spec 002 A-7). */
  source?: string;
  /** Object state before this packet, when it exists. Only present in the 'apply' phase after decode. */
  existing?: unknown;
}

export interface PacketValidator {
  readonly id: string;
  /** Phases this validator runs in. The same validator can serve both. */
  readonly phases: readonly ValidationPhase[];
  /**
   * `body` is undefined for packets that can't be decoded yet (signature
   * checks should work on the envelope alone).
   */
  validate(
    phase: ValidationPhase,
    envelope: DataPacketEnvelope,
    body: PacketBody | undefined,
    ctx: ValidatorContext,
  ): Promise<ValidationResult> | ValidationResult;
}

export interface ExtensionRegistry {
  registerCodec(codec: PayloadCodec, opts?: { makeDefault?: boolean }): void;
  registerValidator(validator: PacketValidator): void;
  registerSigner(signer: PacketSigner): void;
  registerSnapshotGuard(guard: SnapshotGuard): void;
  registerCompactionPin(pin: CompactionPin): void;
  /** Re-run deferred/parked packets, for example after a key arrives. */
  revalidate(opts?: { space?: string }): Promise<{ applied: number; stillParked: number }>;
}

/** Spec 002 A-1: fills envelope.sig for locally authored packets. `bytes` = canonical envelope with sig null. */
export interface PacketSigner {
  readonly id: string;
  sign(bytes: Uint8Array, ctx: { space: string; author: string }): Promise<Uint8Array>;
}

/** Spec 002 A-3: seals and authenticates snapshot messages. */
export interface SnapshotGuard {
  seal(space: string, objects: unknown[]): Promise<Uint8Array>;
  open(space: string, bytes: Uint8Array): Promise<{ ok: true; objects: unknown[] } | { ok: false; reason: 'missing-key' | 'malformed' }>;
  sign(space: string, canonical: Uint8Array): Promise<{ signer: string; sig: Uint8Array }>;
  verify(space: string, signer: string | undefined, canonical: Uint8Array, sig: Uint8Array | undefined): Promise<{ accept: true } | { accept: false; reason: string }>;
}

/** Spec 002 A-6: matching objects are never folded into snapshots or deleted by compaction. */
export type CompactionPin = (type: string, obj: string) => boolean;
