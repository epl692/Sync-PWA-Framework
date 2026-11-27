/**
 * LinkServer: the Hub's side of link/1 over a `BleBridge` (specs/005-bluetooth-transport/contracts/bluetooth-link.md).
 * It runs the secure handshake, verifies membership proofs without holding any content key, enforces the client slot limit,
 * and hands admitted core messages to the caller (the relay). It knows nothing about packets.
 */

import { base32 } from '@sync/core';
import {
  LINK_UUIDS,
  LINK_VERSIONS,
  LinkChannel,
  LinkError,
  Kind,
  ProbeCollector,
  Resync,
  StrikeWindow,
  acceptHello,
  busyAck,
  concat,
  encodeInfo,
  b64uDecode,
  type ControlMessage,
  type HubInfo,
} from '@sync/transport-bluetooth/link';
import { verifyMembership, type AuthEntry } from '../access/verify';
import type { Claim } from '../access/autoSpaces';
import type { ClientGate } from '../clients';
import { HandshakeLimiter } from './limits';
import type { BleBridge, BleConnId } from '../bridge';
import type { HubIdentity } from '../identity';
import type { HubSettings, ServedSpaceRecord } from '../types';

export interface PeerHandle {
  /** Peer id for the relay: `c:<device>`. */
  id: string;
  conn: BleConnId;
  device: string;
  name: string;
  /** Spaces this client proved membership for in this session. */
  spaces: string[];
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
}

export interface LinkServerOptions {
  bridge: BleBridge;
  identity: HubIdentity;
  settings(): HubSettings;
  records(): Iterable<ServedSpaceRecord>;
  now?(): number;
  timers?: Timers;
  maxMessageBytes?: number;
  /** A client authenticated and may sync. */
  onPeerReady(peer: PeerHandle): void;
  onPeerGone(peer: PeerHandle): void;
  /** A message was lost on the link (noticed here or reported by the client): restart the sync handshake with this client. */
  onPeerResync?(peer: PeerHandle): void;
  /** Approval, blocking and strikes (spec US2). Default: every proven member is trusted. */
  gate?: ClientGate;
  /** Automatic Space mode: register a claimed Space if allowed. Returns true if the Space is now served. */
  claim?(c: { claim: Claim; entry: AuthEntry | undefined; hubFingerprint: Uint8Array; nc: Uint8Array; nh: Uint8Array }): Promise<boolean>;
  /** A core message from an admitted client. */
  onCore(peer: PeerHandle, bytes: Uint8Array): void;
}

const MAX_FRAME = 244;
const AUTH_DEADLINE_MS = 20_000;
const PROBE_WAIT_MS = 300;
const KEEPALIVE_TICK_MS = 1_000;
const PING_AFTER_MS = 15_000;
const DEAD_AFTER_MS = 45_000;
const BUSY_RETRY_MS = 5_000;
const PENDING_MS = 10 * 60_000;
const STRIKE_WINDOW_MS = 10 * 60_000;
const DEV_LABEL = new TextEncoder().encode('sync-hub-dev/1');

interface Conn {
  id: BleConnId;
  mtu: number;
  channel: LinkChannel;
  state: 'hello' | 'auth' | 'pending' | 'ready' | 'closing';
  /** Set once the device is proven (never from a claim alone). */
  device?: string;
  slot: boolean;
  nc?: Uint8Array;
  nh?: Uint8Array;
  hubFingerprint?: Uint8Array;
  peer?: PeerHandle;
  probes: ProbeCollector;
  probeTimer?: unknown;
  probeSent: boolean;
  authTimer?: unknown;
  lastRx: number;
  resyncer?: Resync;
  strikes: StrikeWindow;
}

const globalTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as never),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as never),
};

export class LinkServer {
  private readonly conns = new Map<BleConnId, Conn>();
  private readonly byPeer = new Map<string, Conn>();
  private offs: Array<() => void> = [];
  private keepalive: unknown;
  private started = false;
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly maxMessageBytes: number;
  private readonly limiter = new HandshakeLimiter();

  constructor(private readonly o: LinkServerOptions) {
    this.now = o.now ?? (() => Date.now());
    this.timers = o.timers ?? globalTimers;
    this.maxMessageBytes = o.maxMessageBytes ?? 4 * 1024 * 1024;
  }

  /** Number of client slots in use. */
  get active(): number {
    return [...this.conns.values()].filter((c) => c.slot).length;
  }

  info(): HubInfo {
    const s = this.o.settings();
    const slots = Math.max(0, s.maxClients - this.active);
    return {
      v: LINK_VERSIONS,
      name: s.displayName,
      fp: this.o.identity.fingerprintText,
      mode: s.accessMode,
      slots,
      full: slots === 0,
      ...(s.autoSpaces ? { auto: true } : {}),
      maxWrite: MAX_FRAME,
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const b = this.o.bridge;
    this.offs = [
      b.on('connected', (id, info) => this.onConnected(id, info.mtu)),
      b.on('mtu', (id, mtu) => this.onMtu(id, mtu)),
      b.on('write', (id, frame) => void this.conns.get(id)?.channel.onFrame(frame)),
      b.on('disconnected', (id) => this.onDisconnected(id)),
    ];
    this.keepalive = this.timers.setInterval(() => this.tick(), KEEPALIVE_TICK_MS);
    await b.startAdvertising({ ...LINK_UUIDS, name: this.o.settings().displayName, info: encodeInfo(this.info()), maxConnections: this.o.settings().maxClients });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.timers.clearInterval(this.keepalive);
    for (const off of this.offs) off();
    this.offs = [];
    for (const c of [...this.conns.values()]) {
      this.drop(c);
      await this.o.bridge.disconnect(c.id).catch(() => undefined);
    }
    await this.o.bridge.stopAdvertising().catch(() => undefined);
  }

  /** Re-publish INFO (slots, mode, name) after something changed. */
  async refreshInfo(): Promise<void> {
    if (this.started) await this.o.bridge.setInfo(encodeInfo(this.info())).catch(() => undefined);
  }

  /** Send a core message to an admitted client. Rejects if the client is gone. */
  async send(peerId: string, bytes: Uint8Array): Promise<void> {
    const c = this.byPeer.get(peerId);
    if (!c || c.state !== 'ready') throw new Error(`peer ${peerId} is not connected`);
    await c.channel.sendCore(bytes);
  }

  /** Drop a client (owner action, strike, or limit). */
  async disconnect(peerId: string, reason?: string): Promise<void> {
    const c = this.byPeer.get(peerId);
    if (!c) return;
    await this.close(c, reason);
  }

  /** Devices with a live connection that has been proven, including ones waiting for approval. */
  connectedDevices(): Set<string> {
    return new Set([...this.conns.values()].filter((c) => c.device && c.state !== 'closing').map((c) => c.device!));
  }

  /** Close every connection of a device (owner block or deny). */
  async disconnectDevice(device: string): Promise<void> {
    // a connection waiting for approval answers `denied` and closes itself; closing it here would cut that answer off
    for (const c of [...this.conns.values()]) if (c.device === device && c.state !== 'pending') await this.close(c, 'owner');
  }

  peers(): PeerHandle[] {
    return [...this.byPeer.values()].filter((c) => c.state === 'ready').map((c) => c.peer!);
  }

  // ---- connection lifecycle ----

  private onConnected(id: BleConnId, mtu: number): void {
    const conn: Conn = {
      id,
      mtu,
      state: 'hello',
      slot: false,
      probes: new ProbeCollector(),
      probeSent: false,
      lastRx: this.now(),
      strikes: new StrikeWindow(3, STRIKE_WINDOW_MS),
      channel: undefined as unknown as LinkChannel,
    };
    conn.channel = new LinkChannel({
      maxMessageBytes: this.maxMessageBytes,
      frameBytes: Math.min(MAX_FRAME, Math.max(20, mtu - 3)),
      write: (f) => this.o.bridge.notify(id, f),
      now: this.now,
      onWriteFailed: () => void this.close(conn, 'write-failed'),
      handlers: {
        plain: (m) => this.onPlain(conn, m),
        control: (m) => this.onControl(conn, m),
        core: (b) => this.onCore(conn, b),
        strike: (reason) => this.strike(conn, reason),
        lost: () => conn.resyncer?.detected(),
        probe: (n) => this.onProbe(conn, n),
      },
    });
    this.conns.set(id, conn);
    conn.authTimer = this.timers.setTimeout(() => {
      if (conn.state === 'hello' || conn.state === 'auth') void this.close(conn, 'auth-timeout');
    }, AUTH_DEADLINE_MS);
  }

  private onMtu(id: BleConnId, mtu: number): void {
    const c = this.conns.get(id);
    if (!c) return;
    c.mtu = mtu;
    c.channel.framer.frameBytes = Math.min(MAX_FRAME, Math.max(20, mtu - 3));
  }

  private onDisconnected(id: BleConnId): void {
    const c = this.conns.get(id);
    if (c) this.drop(c);
  }

  private drop(c: Conn): void {
    if (!this.conns.delete(c.id)) return;
    c.state = 'closing';
    c.resyncer?.dispose();
    this.timers.clearTimeout(c.authTimer);
    this.timers.clearTimeout(c.probeTimer);
    const wasSlot = c.slot;
    c.slot = false;
    if (c.device) this.o.gate?.seen(c.device, []);
    if (c.peer && this.byPeer.get(c.peer.id) === c) {
      this.byPeer.delete(c.peer.id);
      this.o.onPeerGone(c.peer);
    }
    if (wasSlot) void this.refreshInfo();
  }

  private async close(c: Conn, _reason?: string): Promise<void> {
    if (c.state === 'closing') return;
    const conn = c.id;
    this.drop(c);
    await this.o.bridge.disconnect(conn).catch(() => undefined);
  }

  private strike(c: Conn, _reason: string): void {
    if (c.state === 'closing') return;
    // a strike before the device is proven counts against the connection only: a claimed ID is not evidence of who it is
    const blocked = c.device && this.o.gate ? this.o.gate.strike(c.device) : false;
    if (c.strikes.record(this.now()) || blocked) void this.close(c, 'too-many-strikes');
  }

  private tick(): void {
    const t = this.now();
    for (const c of [...this.conns.values()]) {
      if (c.state === 'ready') c.channel.check(t);
      if (c.state !== 'ready') continue;
      const idle = t - c.lastRx;
      if (idle >= DEAD_AFTER_MS) void this.close(c, 'keepalive');
      else if (idle >= PING_AFTER_MS) void c.channel.sendControl({ t: 'ping' }).catch(() => undefined);
    }
  }

  // ---- messages ----

  private async onPlain(c: Conn, msg: Uint8Array): Promise<void> {
    c.lastRx = this.now();
    if (c.state !== 'hello' || msg[0] !== Kind.HELLO) return this.strike(c, 'unexpected-hello');
    const s = this.o.settings();
    if (!this.limiter.allowHello(this.now()) || this.active >= s.maxClients) {
      c.channel.sendPlain(busyAck(LINK_VERSIONS[1], BUSY_RETRY_MS));
      this.timers.setTimeout(() => void this.close(c, 'busy'), 500);
      return;
    }
    try {
      const h = await acceptHello(msg, this.o.identity, LINK_VERSIONS);
      c.slot = true;
      c.nc = h.nc;
      c.nh = h.nh;
      c.hubFingerprint = h.hubFingerprint;
      c.channel.sendPlain(h.ack);
      c.channel.setSession(h.session);
      c.state = 'auth';
      void this.refreshInfo();
    } catch (e) {
      if (e instanceof LinkError && e.code === 'version-mismatch') await this.close(c, 'version-mismatch');
      else this.strike(c, 'bad-hello');
    }
  }

  private async onControl(c: Conn, msg: { t: string } & Record<string, unknown>): Promise<void> {
    c.lastRx = this.now();
    if (c.state === 'auth') {
      if (msg.t === 'auth') await this.onAuth(c, msg);
      else if (msg.t === 'bye') await this.close(c, 'bye');
      else if (msg.t !== 'ping' && msg.t !== 'pong') this.strike(c, 'before-auth');
      return;
    }
    if (c.state === 'pending') {
      if (msg.t === 'bye') await this.close(c, 'bye');
      else if (msg.t !== 'ping' && msg.t !== 'pong') this.strike(c, 'while-pending');
      else if (msg.t === 'ping') await c.channel.sendControl({ t: 'pong' }).catch(() => undefined);
      return;
    }
    if (c.state !== 'ready') return;
    switch (msg.t) {
      case 'ping':
        await c.channel.sendControl({ t: 'pong' }).catch(() => undefined);
        break;
      case 'bye':
        await this.close(c, 'bye');
        break;
      case 'resync':
      case 'resync-ack':
        c.resyncer?.onMessage(msg);
        break;
      case 'error':
        if (msg.fatal === true) await this.close(c, 'peer-error');
        break;
      default:
        break; // pong and unknown control types are ignored
    }
  }

  private async onAuth(c: Conn, m: Record<string, unknown>): Promise<void> {
    if (!c.nc || !c.nh || !c.hubFingerprint) return;
    const device = typeof m.device === 'string' ? m.device : '';
    const pub = b64uDecode(m.devicePub);
    const devSig = b64uDecode(m.devSig);
    const spaces = Array.isArray(m.spaces) ? (m.spaces as unknown[]) : [];
    if (!device || !pub || !devSig || spaces.length > 64) return this.strike(c, 'bad-auth');
    // the device ID is self-certifying: it must be the hash of the key that signed the session binding
    const id = base32(new Uint8Array(await crypto.subtle.digest('SHA-256', pub as unknown as BufferSource)).slice(0, 16));
    if (id !== device || !(await verifyDevice(pub, devSig, concat(DEV_LABEL, c.hubFingerprint, c.nc, c.nh)))) return this.strike(c, 'bad-auth');
    if (c.state !== 'auth') return;
    c.device = device; // proven: from here strikes count against the device
    if (!this.limiter.allowDevice(device, this.now())) {
      await c.channel.sendControl({ t: 'reject', code: 'busy', retryMs: 60_000 }).catch(() => undefined);
      this.timers.setTimeout(() => void this.close(c, 'rate-limited'), 300);
      return;
    }

    const entries: AuthEntry[] = [];
    for (const e of spaces) {
      const o = e as Partial<AuthEntry>;
      if (typeof o?.space === 'string' && typeof o.epoch === 'number' && typeof o.sig === 'string') entries.push({ space: o.space, epoch: o.epoch, sig: o.sig });
    }
    // automatic Space mode: honor claims for Spaces not served yet (each must prove it holds the claimed key)
    if (this.o.claim && Array.isArray(m.claim)) {
      for (const cl of (m.claim as unknown[]).slice(0, 64)) {
        const claim = cl as Partial<Claim>;
        if (typeof claim?.space !== 'string' || typeof claim.epoch !== 'number' || typeof claim.accessPublicKey !== 'string') continue;
        const entry = entries.find((e) => e.space === claim.space && e.epoch === claim.epoch);
        await this.o.claim({ claim: claim as Claim, entry, hubFingerprint: c.hubFingerprint, nc: c.nc, nh: c.nh });
      }
    }
    const { accepted, rejected } = await verifyMembership({ records: this.o.records(), entries, hubFingerprint: c.hubFingerprint, nc: c.nc, nh: c.nh, now: this.now() });
    if (c.state !== 'auth') return;
    if (!accepted.length) {
      await c.channel.sendControl({ t: 'reject', code: 'not-served' }).catch(() => undefined);
      this.timers.setTimeout(() => void this.close(c, 'not-served'), 300);
      return;
    }
    const name = typeof m.name === 'string' ? m.name.slice(0, 64) : 'device';

    // the owner's access rules: open mode trusts a proven member; approval mode holds a new device until the owner decides
    const verdict = this.o.gate ? await this.o.gate.decide({ device, name, spaces: accepted }) : 'trusted';
    if (c.state !== 'auth') return;
    if (verdict === 'blocked') {
      await c.channel.sendControl({ t: 'reject', code: 'blocked' }).catch(() => undefined);
      this.timers.setTimeout(() => void this.close(c, 'blocked'), 300);
      return;
    }
    if (verdict === 'pending') {
      c.state = 'pending';
      await c.channel.sendControl({ t: 'pending' }).catch(() => undefined);
      const outcome = await Promise.race([
        this.o.gate!.decision(device),
        new Promise<'timeout'>((resolve) => this.timers.setTimeout(() => resolve('timeout'), PENDING_MS)),
      ]);
      if (c.state !== 'pending') return; // the connection went away while it waited
      if (outcome !== 'approved') {
        await c.channel.sendControl({ t: 'reject', code: 'denied' }).catch(() => undefined);
        this.timers.setTimeout(() => void this.close(c, outcome), 300);
        return;
      }
    }

    // one logical connection per device: a newer connection replaces an older one
    const peerId = `c:${device}`;
    const older = this.byPeer.get(peerId);
    if (older && older !== c) await this.close(older, 'replaced');
    const peer: PeerHandle = { id: peerId, conn: c.id, device, name, spaces: accepted };
    c.peer = peer;
    c.resyncer = new Resync({
      send: (m) => void c.channel.sendControl(m).catch(() => undefined),
      bounce: () => this.o.onPeerResync?.(peer),
      failed: () => void this.close(c, 'resync-failed'),
      timers: this.timers,
      now: this.now,
    });
    c.state = 'ready';
    this.timers.clearTimeout(c.authTimer);
    this.byPeer.set(peerId, c);
    this.o.gate?.seen(device, accepted);
    await c.channel.sendControl({ t: 'auth-ok', state: 'trusted', accepted, rejected });
    this.o.onPeerReady(peer);
  }

  private onCore(c: Conn, bytes: Uint8Array): void {
    c.lastRx = this.now();
    if (c.state !== 'ready' || !c.peer) return this.strike(c, 'core-before-auth');
    this.o.onCore(c.peer, bytes);
  }

  private onProbe(c: Conn, frameBytes: number): void {
    c.lastRx = this.now();
    if (c.state === 'closing' || c.probeSent) return;
    c.probes.onProbeLength(frameBytes);
    if (frameBytes >= MAX_FRAME) return void this.sendProbeResult(c);
    if (c.probeTimer === undefined) c.probeTimer = this.timers.setTimeout(() => this.sendProbeResult(c), PROBE_WAIT_MS);
  }

  private sendProbeResult(c: Conn): void {
    if (c.probeSent || c.state === 'closing') return;
    c.probeSent = true;
    this.timers.clearTimeout(c.probeTimer);
    const notify = Math.min(MAX_FRAME, Math.max(20, c.mtu - 3));
    const msg: ControlMessage = { t: 'probe-result', received: c.probes.received(), notify };
    void c.channel.sendControl(msg).catch(() => undefined);
    c.channel.framer.frameBytes = notify;
  }
}

async function verifyDevice(pub: Uint8Array, sig: Uint8Array, msg: Uint8Array): Promise<boolean> {
  if (pub.length !== 32 || sig.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey('raw', pub as unknown as BufferSource, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, sig as unknown as BufferSource, msg as unknown as BufferSource);
  } catch {
    return false;
  }
}
