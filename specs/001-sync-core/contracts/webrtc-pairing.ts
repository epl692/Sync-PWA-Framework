/**
 * Pairing API of @sync/transport-webrtc (manual signaling, no server).
 * The transport still satisfies the generic Transport contract; this is its
 * transport-specific extension, used by app UI (QR display, scanner, paste box).
 */

import type { Transport } from './transport';

/** Opaque, copy-pasteable / QR-encodable string. Deflate + base64url of PairingPayload. */
export type PairingCode = string;

export interface PairingPayload {
  ver: 1;
  kind: 'offer' | 'answer';
  sdp: string;          // complete (non-trickle) session description with candidates
  nonce: string;        // random, ties an answer to its offer
  expiresAt: number;    // epoch ms; default now + 10 minutes
}

export type PairingErrorCode = 'malformed' | 'expired' | 'reused' | 'mismatch' | 'timeout' | 'unreachable';

export class PairingError extends Error {
  constructor(readonly code: PairingErrorCode, message: string) { super(message); }
}

export interface WebRtcTransportOptions {
  /** Default: none (LAN / offline). Add STUN/TURN to cross NATs. */
  iceServers?: RTCIceServer[];
  codeTtlMs?: number;          // default 10 min
  connectTimeoutMs?: number;   // default 30 s
}

export interface WebRtcTransport extends Transport {
  /** Step 1 (initiator): returns the code to show as QR / text. Resolves once ICE gathering is complete. */
  createOffer(): Promise<{ code: PairingCode; sessionId: string }>;
  /** Step 2 (responder): consumes an offer code, returns the answer code to show back. */
  acceptOffer(code: PairingCode): Promise<{ code: PairingCode; sessionId: string }>;
  /** Step 3 (initiator): consumes the answer. Resolves when the data channel is open. */
  acceptAnswer(sessionId: string, code: PairingCode): Promise<void>;
  /** Abort an unfinished pairing and release resources. */
  cancelPairing(sessionId: string): void;
}

/** Codes are single-use: consuming the same code twice throws PairingError('reused'). Bad input never leaves a half-open connection. */
