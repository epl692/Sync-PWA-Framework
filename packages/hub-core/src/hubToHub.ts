/**
 * Hub-to-Hub linking (research R-14, spec FR-010): a Hub that holds a link code for a Space scans for other Hubs and, when both hold
 * the Space, connects as a Bluetooth central, runs the normal client handshake with membership proofs made from the link code's
 * access secret, and syncs through the relay like any client. The Hub with the lower fingerprint initiates; the other waits.
 */

import { base32 } from '@sync/core';
import { ClientLink, createMemoryTrustStore, type GattLink, type HubProofProvider } from '@sync/transport-bluetooth/client';
import { LINK_UUIDS, concat, parseInfo } from '@sync/transport-bluetooth/link';
import { authMessage, spaceIdBytes } from './access/verify';
import type { BleBridge, BleConnId } from './bridge';
import type { HubIdentity } from './identity';
import type { RelayHub } from './relay/relayHub';
import { encodeMessage } from '@sync/core';
import type { HubSettings, ServedSpaceRecord } from './types';

const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
const bs = (u: Uint8Array) => u as unknown as BufferSource;
const RETRY_AFTER_MS = 5_000;

export interface HubToHubOptions {
  bridge: BleBridge;
  identity: HubIdentity;
  settings(): HubSettings;
  records(): Iterable<ServedSpaceRecord>;
  relay: RelayHub;
  now(): number;
  /** The relay's admission set for a peer, kept in step with the link. */
  setPeerSpaces(peerId: string, spaces: Set<string> | undefined): void;
  onLinked?(fingerprint: string, spaces: string[]): void;
  onUnlinked?(fingerprint: string): void;
}

/** A GattLink over the bridge's central role. */
function bridgeGattLink(bridge: BleBridge, conn: BleConnId, info: Uint8Array, name: string): GattLink {
  const frameCbs: Array<(f: Uint8Array) => void> = [];
  const dropCbs: Array<() => void> = [];
  const offs = [
    bridge.on('notify', (c, f) => c === conn && frameCbs.forEach((cb) => cb(f))),
    bridge.on('disconnected', (c) => c === conn && dropCbs.forEach((cb) => cb())),
  ];
  let chain: Promise<void> = Promise.resolve();
  return {
    id: conn,
    name,
    info: async () => info,
    write(frame) {
      const run = chain.then(() => bridge.write(conn, frame));
      chain = run.catch(() => undefined);
      return run;
    },
    onFrame: (cb) => void frameCbs.push(cb),
    onDisconnect: (cb) => void dropCbs.push(cb),
    close() {
      for (const off of offs) off();
      void bridge.disconnect(conn).catch(() => undefined);
    },
  };
}

async function signingKey(seed: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', bs(concat(PKCS8_PREFIX, seed)), { name: 'Ed25519' }, false, ['sign']);
}

export class HubToHub {
  private readonly linked = new Map<string, { link: ClientLink; peerId: string }>();
  private readonly busy = new Set<string>();
  private readonly recent = new Map<string, number>();
  private offSeen: (() => void) | undefined;
  private stopped = false;

  constructor(private readonly o: HubToHubOptions) {}

  async start(): Promise<void> {
    const support = await this.o.bridge.support();
    if (!support.central.ok) return;
    this.offSeen = this.o.bridge.on('seen', (d) => void this.consider(d.address));
    await this.o.bridge.startScan(LINK_UUIDS.serviceUuid).catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.offSeen?.();
    await this.o.bridge.stopScan().catch(() => undefined);
    for (const { link } of [...this.linked.values()]) link.close('stopped');
    this.linked.clear();
  }

  /** Send a core message to a linked Hub. */
  async send(peerId: string, bytes: Uint8Array): Promise<void> {
    const e = [...this.linked.values()].find((l) => l.peerId === peerId);
    if (!e) throw new Error(`Hub ${peerId} is not linked`);
    await e.link.send(bytes);
  }

  isHubPeer(peerId: string): boolean {
    return peerId.startsWith('h:');
  }

  linkedFingerprints(): string[] {
    return [...this.linked.keys()];
  }

  /** The Spaces we hold a link code for, with their highest epoch and secret. */
  private linkSpaces(): Array<{ space: string; epoch: number; seed: Uint8Array; publicKey: Uint8Array }> {
    const out = [];
    for (const r of this.o.records()) {
      if (!r.accessSecret) continue;
      const top = [...r.accessKeys].sort((a, b) => b.epoch - a.epoch)[0];
      if (top) out.push({ space: r.space, epoch: top.epoch, seed: r.accessSecret, publicKey: top.publicKey });
    }
    return out;
  }

  private async consider(address: string): Promise<void> {
    if (this.stopped || !this.o.settings().hubToHub || this.busy.has(address)) return;
    if (!this.linkSpaces().length) return;
    const last = this.recent.get(address);
    if (last !== undefined && this.o.now() - last < RETRY_AFTER_MS) return;
    this.recent.set(address, this.o.now());
    this.busy.add(address);
    try {
      await this.connectTo(address);
    } catch {
      /* out of range, refused, or full: scanning will find it again */
    } finally {
      this.busy.delete(address);
    }
  }

  private async connectTo(address: string): Promise<void> {
    const bridge = this.o.bridge;
    const { conn, info } = await bridge.connect(address);
    const parsed = parseInfo(info);
    const own = this.o.identity.fingerprintText;
    // the Hub with the lower fingerprint initiates; this also keeps a Hub from linking to itself or twice to the same Hub
    if (!parsed || parsed.fp === own || own > parsed.fp || this.linked.has(parsed.fp)) {
      await bridge.disconnect(conn).catch(() => undefined);
      return;
    }
    const spaces = this.linkSpaces();
    const proofs: HubProofProvider = {
      spaces: async () => spaces.map((s) => ({ space: s.space, epoch: s.epoch })),
      proveSpace: async (a) => {
        const s = spaces.find((x) => x.space === a.space && x.epoch === a.epoch);
        const raw = spaceIdBytes(a.space);
        if (!s || !raw) throw new Error('no link code for that Space');
        const sig = await crypto.subtle.sign({ name: 'Ed25519' }, await signingKey(s.seed), bs(authMessage({ hubFingerprint: a.hubFingerprint, nc: a.nc, nh: a.nh, space: raw, epoch: a.epoch })));
        return new Uint8Array(sig);
      },
      proveDevice: async (a) => {
        const id = this.o.identity;
        const sig = await id.sign(concat(new TextEncoder().encode('sync-hub-dev/1'), a.hubFingerprint, a.nc, a.nh));
        const device = base32(new Uint8Array(await crypto.subtle.digest('SHA-256', bs(id.publicKey))).slice(0, 16));
        return { device, publicKey: id.publicKey, sig, name: this.o.settings().displayName };
      },
      accessPublic: async (space) => spaces.find((s) => s.space === space)!.publicKey,
    };
    const gatt = bridgeGattLink(bridge, conn, info, parsed.name);
    let peerId = '';
    const link: ClientLink = new ClientLink({
      gatt,
      proofs,
      trust: createMemoryTrustStore(),
      confirmHub: async () => true, // the owner authorised this by importing the link code
      maxMessageBytes: 4 * 1024 * 1024,
      now: this.o.now,
      onCore: (bytes) => this.o.relay.onMessage(peerId, bytes),
      onClosed: () => {
        const entry = [...this.linked.entries()].find(([, v]) => v.link === link);
        if (!entry) return;
        this.linked.delete(entry[0]);
        this.o.relay.onDisconnect(entry[1].peerId);
        this.o.setPeerSpaces(entry[1].peerId, undefined);
        this.o.onUnlinked?.(entry[0]);
      },
    });
    const result = await link.connect();
    peerId = `h:${result.fingerprint}`;
    this.linked.set(result.fingerprint, { link, peerId });
    const accepted = result.acceptedSpaces;
    this.o.setPeerSpaces(peerId, new Set(accepted));
    // a Hub is a peer that shares exactly the Spaces both sides serve: announce them on the wire and to our own relay
    const hello = encodeMessage({ t: 'hello', protocol: { min: 1, max: 1 }, device: this.o.settings().displayName, spaces: accepted, relay: true });
    this.o.relay.onConnect(peerId);
    this.o.relay.onMessage(peerId, hello);
    await link.send(hello);
    this.o.onLinked?.(result.fingerprint, accepted);
  }
}
