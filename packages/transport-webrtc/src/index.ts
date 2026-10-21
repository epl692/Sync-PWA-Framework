/**
 * WebRTC data-channel transport with manual signaling (no server). The app drives pairing:
 *   A: createOffer()         -> show the code (QR or text)
 *   B: acceptOffer(code)     -> show the answer code
 *   A: acceptAnswer(id, code)
 * After that the channel carries sync messages, framed to the ~16 KiB interop limit.
 * See specs/001-sync-core/contracts/webrtc-pairing.ts.
 */

import {
  FRAME_OVERHEAD,
  FrameError,
  Reassembler,
  chunk,
  newId,
  type PeerId,
  type Transport,
  type TransportCapabilities,
  type TransportEvents,
  type TransportState,
} from '@sync/core';
import { PairingError, PairingLedger, decodePairing, encodePairing, type PairingCode } from './pairingCode';

export { PairingError, decodePairing, encodePairing, type PairingCode, type PairingPayload, type PairingErrorCode } from './pairingCode';

export interface WebRtcTransportOptions {
  /** Transport id (default "webrtc"). */
  id?: string;
  /** Default: none, which works on a shared LAN / offline. Add STUN/TURN to cross NATs. */
  iceServers?: RTCIceServer[];
  /** How long a pairing code stays valid. Default 10 minutes. */
  codeTtlMs?: number;
  /** How long to wait for the channel to open after exchanging codes. Default 30 s. */
  connectTimeoutMs?: number;
  /** How long to wait for ICE gathering before using what we have. Default 4 s. */
  iceGatherTimeoutMs?: number;
  /** Largest data-channel message. Default 16 KiB (the interoperable size). */
  maxFrameBytes?: number;
  /** Inject an implementation (tests). Pass null to force "unsupported". */
  RTCPeerConnection?: typeof RTCPeerConnection | null;
  now?: () => number;
}

export interface WebRtcTransport extends Transport {
  createOffer(): Promise<{ code: PairingCode; sessionId: string }>;
  acceptOffer(code: PairingCode): Promise<{ code: PairingCode; sessionId: string }>;
  acceptAnswer(sessionId: string, code: PairingCode): Promise<void>;
  cancelPairing(sessionId: string): void;
}

export function createWebRtcTransport(opts: WebRtcTransportOptions = {}): WebRtcTransport {
  return new WebRtcTransportImpl(opts);
}

type Handlers = { [K in keyof TransportEvents]: Set<TransportEvents[K]> };

interface Link {
  id: PeerId;
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  reasm: Reassembler;
}

interface Session {
  nonce: string;
  pc: RTCPeerConnection;
  dc?: RTCDataChannel;
  timer?: ReturnType<typeof setTimeout>;
  opened: Promise<void>;
  markOpen(): void;
  fail(e: Error): void;
  done: boolean;
}

class WebRtcTransportImpl implements WebRtcTransport {
  readonly id: string;
  readonly capabilities: TransportCapabilities = { maxMessageBytes: 8 * 1024 * 1024, ordered: true, multiPeer: true, blobs: false };
  private _state: TransportState = 'idle';
  private running = false;
  private links = new Map<PeerId, Link>();
  private sessions = new Map<string, Session>();
  private ledger = new PairingLedger();
  private handlers: Handlers = {
    state: new Set(),
    peerConnected: new Set(),
    peerDisconnected: new Set(),
    message: new Set(),
    error: new Set(),
  };
  private readonly o: Required<Omit<WebRtcTransportOptions, 'RTCPeerConnection' | 'iceServers' | 'id'>> &
    Pick<WebRtcTransportOptions, 'RTCPeerConnection' | 'iceServers'>;

  constructor(opts: WebRtcTransportOptions) {
    this.id = opts.id ?? 'webrtc';
    this.o = {
      codeTtlMs: opts.codeTtlMs ?? 10 * 60_000,
      connectTimeoutMs: opts.connectTimeoutMs ?? 30_000,
      iceGatherTimeoutMs: opts.iceGatherTimeoutMs ?? 4_000,
      maxFrameBytes: opts.maxFrameBytes ?? 16 * 1024,
      now: opts.now ?? (() => Date.now()),
      RTCPeerConnection: opts.RTCPeerConnection,
      iceServers: opts.iceServers,
    };
  }

  get state(): TransportState {
    return this._state;
  }

  private impl(): typeof RTCPeerConnection | undefined {
    if (this.o.RTCPeerConnection === null) return undefined;
    return this.o.RTCPeerConnection ?? (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection;
  }

  supported() {
    if (!this.impl()) return { ok: false as const, reason: 'WebRTC (RTCPeerConnection) is not available in this environment' };
    if (typeof CompressionStream === 'undefined') return { ok: false as const, reason: 'CompressionStream is not available, so pairing codes cannot be built' };
    return { ok: true as const };
  }

  on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): () => void {
    (this.handlers[event] as Set<TransportEvents[K]>).add(handler);
    return () => void (this.handlers[event] as Set<TransportEvents[K]>).delete(handler);
  }

  private emit<K extends keyof TransportEvents>(event: K, ...args: Parameters<TransportEvents[K]>) {
    for (const h of [...(this.handlers[event] as Set<(...a: unknown[]) => void>)]) {
      try {
        h(...args);
      } catch {
        // listeners must not break the transport
      }
    }
  }

  private setState(s: TransportState, detail?: string) {
    if (this._state === s) return;
    this._state = s;
    this.emit('state', s, detail);
  }

  private idleState(): TransportState {
    return this.links.size > 0 ? 'ready' : 'needs-pairing';
  }

  async start(): Promise<void> {
    const s = this.supported();
    if (!s.ok) {
      this.setState('unsupported', s.reason);
      return;
    }
    this.running = true;
    this.setState(this.idleState());
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const id of [...this.sessions.keys()]) this.cancelPairing(id);
    for (const link of [...this.links.values()]) this.dropLink(link, 'stopped');
    if (this._state !== 'unsupported') this.setState('idle');
  }

  // ---- pairing -----------------------------------------------------------------------------

  private requireRunning(): typeof RTCPeerConnection {
    const impl = this.impl();
    if (!impl || !this.running) throw new PairingError('unreachable', 'the WebRTC transport is not running');
    return impl;
  }

  private newSession(nonce: string, pc: RTCPeerConnection): Session {
    let markOpen!: () => void;
    let fail!: (e: Error) => void;
    const opened = new Promise<void>((res, rej) => {
      markOpen = res;
      fail = rej;
    });
    opened.catch(() => undefined);
    const s: Session = { nonce, pc, opened, markOpen, fail, done: false };
    this.sessions.set(nonce, s);
    // an unused offer should not hold a connection open forever
    s.timer = setTimeout(() => {
      if (!s.done) this.cancelPairing(nonce);
    }, this.o.codeTtlMs);
    (s.timer as { unref?: () => void }).unref?.();
    return s;
  }

  private async iceComplete(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === 'complete') return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.o.iceGatherTimeoutMs);
      (timer as { unref?: () => void }).unref?.();
      const check = () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timer);
          resolve();
        }
      };
      pc.onicegatheringstatechange = check;
      pc.onicecandidate = (e) => {
        if (!e.candidate) check();
      };
    });
  }

  async createOffer(): Promise<{ code: PairingCode; sessionId: string }> {
    const RTC = this.requireRunning();
    const pc = new RTC({ iceServers: this.o.iceServers });
    const nonce = newId();
    const session = this.newSession(nonce, pc);
    try {
      session.dc = pc.createDataChannel('sync', { ordered: true });
      this.watch(session, session.dc);
      await pc.setLocalDescription(await pc.createOffer());
      await this.iceComplete(pc);
      const code = await encodePairing({
        ver: 1,
        kind: 'offer',
        sdp: pc.localDescription!.sdp,
        nonce,
        expiresAt: this.o.now() + this.o.codeTtlMs,
      });
      this.setState(this.idleState());
      return { code, sessionId: nonce };
    } catch (e) {
      this.cancelPairing(nonce);
      throw e;
    }
  }

  async acceptOffer(code: PairingCode): Promise<{ code: PairingCode; sessionId: string }> {
    const RTC = this.requireRunning();
    const offer = await decodePairing(code, this.o.now());
    if (offer.kind !== 'offer') throw new PairingError('malformed', 'this is an answer code; paste the offer code here');
    this.ledger.consume(`offer:${offer.nonce}`);

    const pc = new RTC({ iceServers: this.o.iceServers });
    const session = this.newSession(offer.nonce, pc);
    pc.ondatachannel = (ev) => {
      session.dc = ev.channel;
      this.watch(session, ev.channel);
    };
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await this.iceComplete(pc);
      const answer = await encodePairing({
        ver: 1,
        kind: 'answer',
        sdp: pc.localDescription!.sdp,
        nonce: offer.nonce,
        expiresAt: this.o.now() + this.o.codeTtlMs,
      });
      // If the other side never completes its half, give the connection up.
      const timer = setTimeout(() => {
        if (session.done) return;
        this.emit('error', { code: 'unreachable', message: 'the other device did not connect in time' });
        this.cancelPairing(offer.nonce);
      }, this.o.connectTimeoutMs);
      (timer as { unref?: () => void }).unref?.();
      session.opened.then(() => clearTimeout(timer), () => clearTimeout(timer));
      return { code: answer, sessionId: offer.nonce };
    } catch (e) {
      this.cancelPairing(offer.nonce);
      throw e;
    }
  }

  async acceptAnswer(sessionId: string, code: PairingCode): Promise<void> {
    this.requireRunning();
    const answer = await decodePairing(code, this.o.now());
    if (answer.kind !== 'answer') throw new PairingError('malformed', 'this is an offer code; paste the answer code here');
    if (this.ledger.has(`answer:${answer.nonce}`)) throw new PairingError('reused', 'this pairing code was already used');
    const session = this.sessions.get(sessionId);
    if (!session || answer.nonce !== sessionId) throw new PairingError('mismatch', 'this answer does not belong to that pairing');
    this.ledger.consume(`answer:${answer.nonce}`);
    try {
      await session.pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      await this.withTimeout(session.opened, this.o.connectTimeoutMs);
    } catch (e) {
      this.emit('error', { code: 'unreachable', message: 'could not reach the other device' });
      this.cancelPairing(sessionId);
      throw e instanceof PairingError ? e : new PairingError('unreachable', String((e as Error).message ?? e));
    }
  }

  private withTimeout(p: Promise<void>, ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new PairingError('timeout', 'the connection did not open in time')), ms);
      (t as { unref?: () => void }).unref?.();
      p.then(
        () => (clearTimeout(t), resolve()),
        (e) => (clearTimeout(t), reject(e)),
      );
    });
  }

  cancelPairing(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    if (s.timer) clearTimeout(s.timer);
    if (!s.done) {
      s.done = true;
      s.fail(new PairingError('timeout', 'pairing was cancelled'));
      try {
        s.pc.close();
      } catch {
        // already closed
      }
    }
    if (this.running) this.setState(this.idleState());
  }

  // ---- data channel ------------------------------------------------------------------------

  /** Wire a channel to its pairing session; once open it becomes a peer. */
  private watch(session: Session, dc: RTCDataChannel): void {
    dc.binaryType = 'arraybuffer';
    const peerId = `rtc-${session.nonce.slice(0, 8)}`;
    const onOpen = () => {
      if (session.done) return;
      session.done = true;
      if (session.timer) clearTimeout(session.timer);
      this.sessions.delete(session.nonce);
      const link: Link = { id: peerId, pc: session.pc, dc, reasm: new Reassembler() };
      this.links.set(peerId, link);
      session.pc.onconnectionstatechange = () => {
        if (session.pc.connectionState === 'failed' || session.pc.connectionState === 'closed') this.dropLink(link, 'connection lost');
      };
      this.setState('ready');
      this.emit('peerConnected', { id: peerId, label: 'WebRTC peer' });
      session.markOpen();
    };
    dc.onopen = onOpen;
    dc.onclose = () => {
      const link = this.links.get(peerId);
      if (link) this.dropLink(link, 'channel closed');
    };
    dc.onmessage = (ev) => {
      const link = this.links.get(peerId);
      if (!link) return;
      const d = ev.data as unknown;
      const frame = d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : undefined;
      if (!frame) return this.emit('error', { code: 'unexpected-text', message: 'ignored a non-binary message', peerId });
      try {
        const msg = link.reasm.push(frame);
        if (msg) this.emit('message', peerId, msg);
      } catch (e) {
        this.emit('error', { code: e instanceof FrameError ? `frame-${e.code}` : 'frame-error', message: String((e as Error).message), peerId });
      }
    };
    if (dc.readyState === 'open') onOpen();
  }

  private dropLink(link: Link, reason: string): void {
    if (this.links.get(link.id) !== link) return;
    this.links.delete(link.id);
    try {
      link.dc.close();
      link.pc.close();
    } catch {
      // already closed
    }
    this.emit('peerDisconnected', link.id, reason);
    if (this.running) this.setState(this.idleState());
  }

  async send(peerId: PeerId, bytes: Uint8Array): Promise<void> {
    const link = this.links.get(peerId);
    if (!link || link.dc.readyState !== 'open') throw new Error('peer is not connected');
    const frames = chunk(bytes, this.o.maxFrameBytes);
    for (const f of frames) {
      if (link.dc.bufferedAmount > 4 * 1024 * 1024) await this.drain(link.dc);
      link.dc.send(f as unknown as ArrayBuffer);
    }
  }

  private drain(dc: RTCDataChannel): Promise<void> {
    return new Promise((resolve) => {
      dc.bufferedAmountLowThreshold = 1024 * 1024;
      const done = () => {
        dc.removeEventListener('bufferedamountlow', done);
        resolve();
      };
      dc.addEventListener('bufferedamountlow', done);
    });
  }
}

export { FRAME_OVERHEAD };
