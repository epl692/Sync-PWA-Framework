/**
 * A Hub link fixture for tests (spec 005): a MemoryBleLink "air", a MockBleBridge, a LinkServer with real crypto, one served Space,
 * and a factory for member clients that prove membership with real access keys. No packet logic: core messages go to callbacks.
 */

import { base32 } from '@sync/core';
import {
  LinkServer,
  applyServeCode,
  createMemoryStore,
  defaultSettings,
  loadOrCreateHubIdentity,
  parseServeCode,
  type HubIdentity,
  type HubSettings,
  type PeerHandle,
  type ServedSpaceRecord,
} from '@sync/hub-core';
import { deriveHubAccess, encodeHubCode, hubAuthMessage, proveHubChallenge } from '@sync/spaces';
import { MemoryBleLink, type BleAirOptions } from '../ble/memoryBleLink';
import { MockBleBridge } from '../ble/mockBleBridge';

export interface FixtureProofs {
  spaces(): Promise<Array<{ space: string; epoch: number }>>;
  proveSpace(a: { space: string; epoch: number; hubFingerprint: Uint8Array; nc: Uint8Array; nh: Uint8Array }): Promise<Uint8Array>;
  proveDevice(a: { hubFingerprint: Uint8Array; nc: Uint8Array; nh: Uint8Array }): Promise<{ device: string; publicKey: Uint8Array; sig: Uint8Array; name: string }>;
  accessPublic(space: string, epoch: number): Promise<Uint8Array>;
  readonly deviceId: string;
}

export interface LinkFixture {
  link: MemoryBleLink;
  bridge: MockBleBridge;
  server: LinkServer;
  identity: HubIdentity;
  settings: HubSettings;
  /** The served Space and its current epoch. */
  space: string;
  epoch: number;
  record: ServedSpaceRecord;
  /** A member device: real device key, real access key for the served Space. */
  newClient(name?: string, over?: { spaces?: Array<{ space: string; epoch: number }> }): Promise<FixtureProofs>;
  peers: PeerHandle[];
  /** Core messages received from clients. */
  inbox: Array<{ peer: string; bytes: Uint8Array }>;
  onCore(cb: (peer: PeerHandle, bytes: Uint8Array) => void): void;
  gone: string[];
  stop(): Promise<void>;
}

const bs = (u: Uint8Array) => u as unknown as BufferSource;
const subtle = () => globalThis.crypto.subtle;
const concat = (...p: Uint8Array[]) => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};
const PKCS8 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

export interface SpaceAccess {
  space: string;
  spaceRaw: Uint8Array;
  epoch: number;
  epochKey: Uint8Array;
  /** A serve code for the Hub owner to import. */
  serveCode: string;
  /** A link code (carries the access secret). */
  linkCode: string;
}

/** A Space (ID, epoch key, access key) and the codes a member would export, for tests. */
export async function createSpaceAccess(o: { seed?: number; keyByte?: number; epoch?: number } = {}): Promise<SpaceAccess> {
  const spaceRaw = Uint8Array.from({ length: 16 }, (_, i) => (0xa0 + i + (o.seed ?? 0)) & 0xff);
  const space = base32(spaceRaw);
  const epoch = o.epoch ?? 4;
  const epochKey = new Uint8Array(32).fill(o.keyByte ?? 0x2a);
  const access = await deriveHubAccess(epochKey, spaceRaw, epoch);
  const serveCode = encodeHubCode({ v: 1, kind: 'serve', space, epoch, accessPublic: access.publicRaw, createdAt: Date.now() });
  const linkCode = encodeHubCode({ v: 1, kind: 'link', space, epoch, accessPublic: access.publicRaw, accessSecret: access.seed, createdAt: Date.now() });
  return { space, spaceRaw, epoch, epochKey, serveCode, linkCode };
}

/** A member device: real device key, and membership proofs for the given Spaces (same epoch key per Space). */
export async function memberProofs(accesses: SpaceAccess[], name = 'client'): Promise<FixtureProofs> {
  const seed = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const priv = await subtle().importKey('pkcs8', bs(concat(PKCS8, seed)), { name: 'Ed25519' }, false, ['sign']);
  const ex = await subtle().importKey('pkcs8', bs(concat(PKCS8, seed)), { name: 'Ed25519' }, true, ['sign']);
  const x = ((await subtle().exportKey('jwk', ex)).x as string).replace(/-/g, '+').replace(/_/g, '/');
  const pub = Uint8Array.from(atob(x + '='.repeat((4 - (x.length % 4)) % 4)), (c) => c.charCodeAt(0));
  const deviceId = base32(new Uint8Array(await subtle().digest('SHA-256', bs(pub))).slice(0, 16));
  const by = new Map(accesses.map((a) => [a.space, a]));
  return {
    deviceId,
    spaces: async () => accesses.map((a) => ({ space: a.space, epoch: a.epoch })),
    async proveSpace(a) {
      const acc = by.get(a.space);
      if (!acc) throw new Error('not a member of that Space');
      const key = await deriveHubAccess(acc.epochKey, acc.spaceRaw, a.epoch);
      return proveHubChallenge(key, hubAuthMessage({ hubFingerprint: a.hubFingerprint, nc: a.nc, nh: a.nh, space: acc.spaceRaw, epoch: a.epoch }));
    },
    async proveDevice(a) {
      const sig = new Uint8Array(await subtle().sign({ name: 'Ed25519' }, priv, bs(concat(new TextEncoder().encode('sync-hub-dev/1'), a.hubFingerprint, a.nc, a.nh))));
      return { device: deviceId, publicKey: pub, sig, name };
    },
    async accessPublic(s, e) {
      const acc = by.get(s);
      if (!acc) throw new Error('not a member of that Space');
      return (await deriveHubAccess(acc.epochKey, acc.spaceRaw, e)).publicRaw;
    },
  };
}

export async function createLinkFixture(o: { air?: BleAirOptions; settings?: Partial<HubSettings>; maxMessageBytes?: number; start?: boolean } = {}): Promise<LinkFixture> {
  const link = new MemoryBleLink(o.air ?? { mtu: 185 });
  const bridge = new MockBleBridge(link);
  const store = createMemoryStore();
  const identity = await loadOrCreateHubIdentity(store);
  const settings: HubSettings = { ...defaultSettings({ fingerprintText: identity.fingerprintText }), ...o.settings };

  const acc = await createSpaceAccess();
  const { space, epoch } = acc;
  const record = applyServeCode(undefined, parseServeCode(acc.serveCode, Date.now()), Date.now(), settings.retentionDays);

  const peers: PeerHandle[] = [];
  const gone: string[] = [];
  const inbox: LinkFixture['inbox'] = [];
  const listeners: Array<(peer: PeerHandle, bytes: Uint8Array) => void> = [];
  const server = new LinkServer({
    bridge,
    identity,
    settings: () => settings,
    records: () => [record],
    ...(o.maxMessageBytes ? { maxMessageBytes: o.maxMessageBytes } : {}),
    onPeerReady: (p) => void peers.push(p),
    onPeerGone: (p) => void gone.push(p.id),
    onCore: (peer, bytes) => {
      inbox.push({ peer: peer.id, bytes });
      for (const l of listeners) l(peer, bytes);
    },
  });
  if (o.start !== false) await server.start();

  async function newClient(name = 'client', over: { spaces?: Array<{ space: string; epoch: number }> } = {}): Promise<FixtureProofs> {
    const p = await memberProofs([acc], name);
    return over.spaces ? { ...p, spaces: async () => over.spaces! } : p;
  }

  return {
    link,
    bridge,
    server,
    identity,
    settings,
    space,
    epoch,
    record,
    newClient,
    peers,
    inbox,
    gone,
    onCore: (cb) => void listeners.push(cb),
    stop: async () => {
      await server.stop();
      await bridge.close();
    },
  };
}

