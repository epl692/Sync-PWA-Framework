/**
 * ClientLink: one connection from a browser to a Hub (contracts/bluetooth-link.md). It reads INFO, runs the secure handshake,
 * pins or checks the Hub key, proves membership, probes the frame size, and then carries core messages. No sync logic here.
 */

import {
  LINK_VERSIONS,
  LinkChannel,
  LinkError,
  b64uEncode,
  chooseFrameBytes,
  fingerprintGroups,
  fingerprintWords,
  parseInfo,
  sendProbes,
  startClientHandshake,
  type HubInfo,
} from './link';
import type { GattLink } from './webBluetooth';
import type { HubProofProvider } from './proofs';
import type { TrustedHubStore } from './trustStore';

export type HubConnectionState =
  | 'searching'
  | 'connecting'
  | 'securing'
  | 'authenticating'
  | 'pending'
  | 'syncing'
  | 'idle'
  | 'disconnected'
  | 'full'
  | 'error';

export interface HubConnectionInfo {
  fingerprint: string;
  name: string;
  state: HubConnectionState;
  /** Spaces the Hub accepted for this session. Never lists Spaces the Hub rejected. */
  acceptedSpaces: string[];
  frameBytes: number;
  pendingOut: number;
  pendingIn: number;
  detail?: string;
}

export interface HubCandidate {
  name: string;
  fingerprint: string;
  words: string[];
  mode: 'open' | 'approval';
  slots: number;
}

export type HubLinkErrorCode =
  | 'update-needed'
  | 'busy'
  | 'identity-changed'
  | 'declined'
  | 'not-served'
  | 'denied'
  | 'rejected'
  | 'timeout'
  | 'protocol';

export class HubLinkError extends Error {
  constructor(
    readonly code: HubLinkErrorCode,
    message: string,
    readonly retryMs?: number,
  ) {
    super(message);
  }
}

export interface ClientTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
  sleep(ms: number): Promise<void>;
}

const realTimers: ClientTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as never),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as never),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export interface ClientLinkOptions {
  gatt: GattLink;
  proofs: HubProofProvider;
  trust: TrustedHubStore;
  confirmHub(h: HubCandidate): Promise<boolean>;
  /** Spaces to prove; default every Space the proof provider offers. */
  spaces?: string[];
  maxMessageBytes: number;
  now?(): number;
  timers?: ClientTimers;
  onCore(bytes: Uint8Array): void;
  onState?(info: HubConnectionInfo): void;
  onIdentityChanged?(info: { fingerprint: string; name: string }): void;
  onClosed(reason: string): void;
}

const HANDSHAKE_MS = 10_000;
const AUTH_MS = 10_000;
const PENDING_MS = 10 * 60_000;
const PROBE_RESULT_MS = 2_000;
const PING_AFTER_MS = 15_000;
const DEAD_AFTER_MS = 45_000;
const TICK_MS = 5_000;

type Control = { t: string } & Record<string, unknown>;

export class ClientLink {
  info: HubConnectionInfo = { fingerprint: '', name: '', state: 'connecting', acceptedSpaces: [], frameBytes: 20, pendingOut: 0, pendingIn: 0 };
  private channel!: LinkChannel;
  private closed = false;
  private lastRx = 0;
  private keepalive: unknown;
  private plainWaiter: ((m: Uint8Array) => void) | undefined;
  private ctrlWaiters: Array<{ types: string[]; resolve: (m: Control) => void }> = [];
  private readonly now: () => number;
  private readonly timers: ClientTimers;

  constructor(private readonly o: ClientLinkOptions) {
    this.now = o.now ?? (() => Date.now());
    this.timers = o.timers ?? realTimers;
  }

  private setState(state: HubConnectionState, detail?: string): void {
    this.info = { ...this.info, state, ...(detail !== undefined ? { detail } : {}) };
    this.o.onState?.(this.info);
  }

  /** Resolves with the connection once the Hub accepted at least one Space (state `syncing`). */
  async connect(): Promise<HubConnectionInfo> {
    const g = this.o.gatt;
    this.lastRx = this.now();
    this.setState('connecting');
    g.onDisconnect(() => this.finish('disconnected'));
    this.channel = new LinkChannel({
      maxMessageBytes: this.o.maxMessageBytes,
      write: (f) => g.write(f),
      now: this.now,
      onWriteFailed: () => this.finish('write-failed'),
      handlers: {
        plain: (m) => {
          this.plainWaiter?.(m);
          this.plainWaiter = undefined;
        },
        control: (m) => this.onControl(m),
        core: (b) => {
          this.lastRx = this.now();
          this.o.onCore(b);
        },
        strike: () => undefined, // a Hub that sends garbage is simply not used; the handshake or auth will time out
      },
    });
    g.onFrame((f) => {
      this.lastRx = this.now();
      void this.channel.onFrame(f);
    });

    try {
      const info = parseInfo(await g.info());
      if (!info) throw new HubLinkError('protocol', 'That device did not look like a Hub.');
      if (info.v[1] < LINK_VERSIONS[0] || info.v[0] > LINK_VERSIONS[1]) throw new HubLinkError('update-needed', 'This Hub needs a newer version of the app, or the other way around. Update and try again.');
      this.info = { ...this.info, fingerprint: info.fp, name: info.name };
      await this.secure(info);
      await this.authenticate(info);
      this.keepalive = this.timers.setInterval(() => this.tick(), TICK_MS);
      void this.probe();
      return this.info;
    } catch (e) {
      this.finish(e instanceof HubLinkError ? e.code : 'error');
      throw e;
    }
  }

  private async secure(info: HubInfo): Promise<void> {
    this.setState('securing');
    const pinned = await this.o.trust.get(info.fp);
    const hs = await startClientHandshake(LINK_VERSIONS);
    const ackP = new Promise<Uint8Array>((resolve, reject) => {
      this.plainWaiter = resolve;
      this.timers.setTimeout(() => reject(new HubLinkError('timeout', 'The Hub did not answer.')), HANDSHAKE_MS);
    });
    this.channel.sendPlain(hs.hello);
    const ack = await ackP;
    let done;
    try {
      done = await hs.finish(ack, pinned?.publicKey);
    } catch (e) {
      if (e instanceof LinkError && e.code === 'hub-identity-changed') {
        this.o.onIdentityChanged?.({ fingerprint: info.fp, name: info.name });
        throw new HubLinkError('identity-changed', 'This Hub has a different identity than the one you trusted before. Check that it is the right Hub.');
      }
      if (e instanceof LinkError && e.code === 'version-mismatch') throw new HubLinkError('update-needed', 'This Hub speaks a different version of the link. Update and try again.');
      throw new HubLinkError('protocol', 'The Hub did not complete the secure handshake.');
    }
    if ('busy' in done) throw new HubLinkError('busy', 'The Hub is full right now.', done.busy.retryMs);
    this.channel.setSession(done.session);
    this.hubNonces = { nc: done.nc, nh: done.nh, fp: done.hubFingerprint };

    const fingerprint = fingerprintGroups(done.hubFingerprint);
    const known = pinned && pinned.fingerprint === fingerprint ? pinned : await this.o.trust.get(fingerprint);
    if (!known) {
      const ok = await this.o.confirmHub({ name: info.name, fingerprint, words: fingerprintWords(done.hubFingerprint), mode: info.mode, slots: info.slots });
      if (!ok) throw new HubLinkError('declined', 'You chose not to trust this Hub.');
    }
    await this.o.trust.put({ fingerprint, name: info.name, autoReconnect: known?.autoReconnect ?? true, publicKey: done.hubKey, lastConnected: this.now(), browserDeviceId: this.o.gatt.id });
    this.info = { ...this.info, fingerprint, name: info.name };
  }

  private hubNonces: { nc: Uint8Array; nh: Uint8Array; fp: Uint8Array } | undefined;

  private async authenticate(info: HubInfo): Promise<void> {
    const h = this.hubNonces!;
    this.setState('authenticating');
    const offered = await this.o.proofs.spaces();
    const wanted = this.o.spaces ? offered.filter((s) => this.o.spaces!.includes(s.space)) : offered;
    const spaces = await Promise.all(
      wanted.map(async (s) => ({ space: s.space, epoch: s.epoch, sig: b64uEncode(await this.o.proofs.proveSpace({ space: s.space, epoch: s.epoch, hubFingerprint: h.fp, nc: h.nc, nh: h.nh })) })),
    );
    const claim = info.auto ? await Promise.all(wanted.map(async (s) => ({ space: s.space, epoch: s.epoch, accessPublicKey: b64uEncode(await this.o.proofs.accessPublic(s.space, s.epoch)) }))) : undefined;
    const dev = await this.o.proofs.proveDevice({ hubFingerprint: h.fp, nc: h.nc, nh: h.nh });
    const reply = this.waitControl(['auth-ok', 'pending', 'reject'], AUTH_MS);
    await this.channel.sendControl({ t: 'auth', device: dev.device, devicePub: b64uEncode(dev.publicKey), devSig: b64uEncode(dev.sig), name: dev.name, spaces, ...(claim ? { claim } : {}) });
    let m = await reply;
    if (m.t === 'pending') {
      this.setState('pending', 'Waiting for the Hub owner to approve this device.');
      m = await this.waitControl(['auth-ok', 'reject'], PENDING_MS);
    }
    if (m.t === 'reject') {
      const code = String(m.code);
      if (code === 'not-served') throw new HubLinkError('not-served', 'This Hub does not serve your Spaces.');
      if (code === 'blocked' || code === 'denied') throw new HubLinkError('denied', 'The Hub owner did not allow this device.');
      throw new HubLinkError('rejected', 'The Hub refused the connection.');
    }
    const accepted = Array.isArray(m.accepted) ? (m.accepted as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    this.info = { ...this.info, acceptedSpaces: accepted };
    this.setState('syncing');
  }

  private waitControl(types: string[], timeoutMs: number): Promise<Control> {
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        this.ctrlWaiters = this.ctrlWaiters.filter((w) => w.resolve !== wrapped);
        reject(new HubLinkError('timeout', 'The Hub did not answer in time.'));
      }, timeoutMs);
      const wrapped = (m: Control) => {
        this.timers.clearTimeout(timer);
        resolve(m);
      };
      this.ctrlWaiters.push({ types, resolve: wrapped });
    });
  }

  private onControl(m: Control): void {
    this.lastRx = this.now();
    const i = this.ctrlWaiters.findIndex((w) => w.types.includes(m.t));
    if (i >= 0) {
      const [w] = this.ctrlWaiters.splice(i, 1);
      w!.resolve(m);
      return;
    }
    switch (m.t) {
      case 'ping':
        void this.channel.sendControl({ t: 'pong' }).catch(() => undefined);
        break;
      case 'bye':
        this.finish('bye');
        break;
      case 'error':
        if (m.fatal === true) this.finish('hub-error');
        break;
      case 'probe-result': {
        const received = Array.isArray(m.received) ? (m.received as unknown[]).filter((x): x is number => typeof x === 'number') : [];
        const notify = typeof m.notify === 'number' ? m.notify : 20;
        this.channel.framer.frameBytes = chooseFrameBytes(received, notify);
        this.info = { ...this.info, frameBytes: this.channel.framer.frameBytes };
        this.o.onState?.(this.info);
        break;
      }
      default:
        break; // unknown control types are ignored (forward compatibility)
    }
  }

  /** After auth: find the largest frame the browser's stack will write. Failures just leave the safe 20-byte frame. */
  private async probe(): Promise<void> {
    try {
      await sendProbes(async (f) => {
        try {
          await this.o.gatt.write(f);
        } catch {
          /* a probe larger than the stack allows simply is not counted */
        }
      }, (ms) => this.timers.sleep(ms));
      await this.waitControl(['probe-result'], PROBE_RESULT_MS).then((m) => this.onControl(m), () => undefined);
    } catch {
      /* ignore */
    }
  }

  private tick(): void {
    const idle = this.now() - this.lastRx;
    if (idle >= DEAD_AFTER_MS) this.finish('keepalive');
    else if (idle >= PING_AFTER_MS) void this.channel.sendControl({ t: 'ping' }).catch(() => undefined);
  }

  /** Carry one core message to the Hub. Lane messages ride stream 1. */
  async send(bytes: Uint8Array): Promise<void> {
    if (this.closed || this.info.state === 'disconnected') throw new Error('the Hub is not connected');
    if (this.info.state !== 'syncing' && this.info.state !== 'idle') throw new Error('the Hub link is not ready');
    await this.channel.sendCore(bytes);
  }

  close(reason = 'closed'): void {
    if (this.closed) return;
    void this.channel?.sendControl({ t: 'bye', reason }).catch(() => undefined);
    this.finish(reason, true);
  }

  private finish(reason: string, polite = false): void {
    if (this.closed) return;
    this.closed = true;
    this.timers.clearInterval(this.keepalive);
    for (const w of this.ctrlWaiters.splice(0)) void w;
    this.setState(reason === 'busy' ? 'full' : reason === 'disconnected' || polite || reason === 'bye' || reason === 'keepalive' ? 'disconnected' : 'error', reason);
    // give a polite `bye` a moment to leave before dropping the radio link
    if (polite) this.timers.setTimeout(() => this.o.gatt.close(), 50);
    else this.o.gatt.close();
    this.o.onClosed(reason);
  }
}
