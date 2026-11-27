/**
 * createHub: the Hub's wiring (specs/005-bluetooth-transport/contracts/hub-core.ts). A relay that stores and forwards opaque
 * packets, a persistent store, the Bluetooth link server, and the owner's control surface. It never holds a content key.
 */

import { LinkServer, type PeerHandle, type Timers } from './link/server';
import { applyServeCode, parseServeCode, pruneExpiredKeys, ServeCodeError } from './access/codes';
import type { BleBridge } from './bridge';
import { loadOrCreateHubIdentity, type HubIdentity } from './identity';
import { RelayHub } from './relay/relayHub';
import { defaultSettings, mergeSettings } from './settings';
import type { HubStore } from './store/types';
import type { ClientInfo, DeviceId, HubControl, HubEvent, HubSettings, ServedSpaceInfo, ServedSpaceRecord, SpaceId } from './types';

export interface HubOptions {
  bridge: BleBridge;
  store: HubStore;
  settings?: Partial<HubSettings>;
  /** What the radio supports (spike S-3): the default `maxClients` is `min(7, this)`. */
  platformMaxClients?: number;
  now?: () => number;
  timers?: Timers;
  maxMessageBytes?: number;
}

export interface Hub extends HubControl {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The relay, for tests and for attaching other transports (spec 005 US4). */
  readonly relay: RelayHub;
  readonly link: LinkServer;
  readonly identity: HubIdentity;
}

export class HubError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function createHub(o: HubOptions): Promise<Hub> {
  const now = o.now ?? (() => Date.now());
  const store = o.store;
  await store.open();
  const identity = await loadOrCreateHubIdentity(store);
  let settings: HubSettings = (await store.settings()) ?? { ...defaultSettings({ fingerprintText: identity.fingerprintText, ...(o.platformMaxClients !== undefined ? { platformMaxClients: o.platformMaxClients } : {}) }), ...o.settings };
  if (!(await store.settings())) await store.saveSettings(settings);
  else if (o.settings) settings = mergeSettings(settings, o.settings);

  const records = new Map<SpaceId, ServedSpaceRecord>();
  for (const r of await store.spaces()) records.set(r.space, r);
  const handlers = new Set<(e: HubEvent) => void>();
  const emit = (e: HubEvent) => {
    for (const h of [...handlers]) h(e);
  };
  const peerSpaces = new Map<string, Set<string>>();
  const connected = new Map<DeviceId, PeerHandle>();
  const bytesPerSpace = new Map<SpaceId, number>();

  // eslint-disable-next-line prefer-const
  let link: LinkServer;
  const relay = new RelayHub(
    (peerId, bytes) => void link.send(peerId, bytes).catch(() => undefined),
    {
      deviceName: settings.displayName,
      admit: (peerId, space) => peerSpaces.get(peerId)?.has(space) === true,
      onStore: (space, id, raw) => {
        bytesPerSpace.set(space, (bytesPerSpace.get(space) ?? 0) + raw.length);
        void store.addPacket(space, id, raw, now()).catch(() => undefined);
      },
    },
  );
  link = new LinkServer({
    bridge: o.bridge,
    identity,
    settings: () => settings,
    records: () => records.values(),
    now,
    ...(o.timers ? { timers: o.timers } : {}),
    ...(o.maxMessageBytes ? { maxMessageBytes: o.maxMessageBytes } : {}),
    onPeerReady: (peer) => {
      peerSpaces.set(peer.id, new Set(peer.spaces));
      connected.set(peer.device, peer);
      relay.onConnect(peer.id);
      emit({ type: 'client-connected', client: clientInfo(peer) });
    },
    onPeerGone: (peer) => {
      if (connected.get(peer.device) === peer) connected.delete(peer.device);
      peerSpaces.delete(peer.id);
      relay.onDisconnect(peer.id);
      emit({ type: 'client-disconnected', device: peer.device });
    },
    onCore: (peer, bytes) => relay.onMessage(peer.id, bytes),
  });

  const clientInfo = (p: PeerHandle): ClientInfo => ({ device: p.device, name: p.name, state: 'trusted', connected: true, spaces: [...p.spaces], lastSeen: now() });
  const spaceInfo = (r: ServedSpaceRecord): ServedSpaceInfo => ({
    space: r.space,
    ...(r.name ? { name: r.name } : {}),
    source: r.source,
    epochs: r.accessKeys.map((k) => k.epoch),
    link: r.accessSecret !== undefined,
    bytesStored: bytesPerSpace.get(r.space) ?? 0,
    addedAt: r.addedAt,
  });

  async function preload(): Promise<void> {
    for (const r of records.values()) {
      const ids: string[] = [];
      let bytes = 0;
      for await (const x of store.listIds(r.space)) {
        ids.push(x.id);
        bytes += x.size;
      }
      bytesPerSpace.set(r.space, bytes);
      for (let i = 0; i < ids.length; i += 200) {
        for (const p of await store.getPackets(r.space, ids.slice(i, i + 200))) relay.preload(r.space, p.bytes);
      }
    }
  }

  const notImplemented = (what: string): never => {
    throw new HubError('not-implemented', `${what} is not available yet`);
  };

  const hub: Hub = {
    relay,
    link,
    identity,
    fingerprint: identity.fingerprintText,

    async start() {
      await preload();
      await link.start();
    },
    async stop() {
      await link.stop();
      await store.close();
    },

    settings: () => ({ ...settings }),
    async updateSettings(patch) {
      settings = mergeSettings(settings, patch);
      await store.saveSettings(settings);
      await link.refreshInfo();
    },

    async addServeCode(code) {
      let parsed;
      try {
        parsed = parseServeCode(code, now());
      } catch (e) {
        if (e instanceof ServeCodeError) throw new HubError(e.code, e.message);
        throw e;
      }
      const rec = applyServeCode(records.get(parsed.space), parsed, now(), settings.retentionDays);
      pruneExpiredKeys(rec, now());
      records.set(rec.space, rec);
      await store.putSpace(rec);
      const info = spaceInfo(rec);
      emit({ type: 'space-added', space: info, auto: false });
      return info;
    },
    async removeSpace(space, opts) {
      records.delete(space);
      await store.deleteSpace(space);
      if (opts.deleteStored) {
        await store.deleteSpacePackets(space);
        bytesPerSpace.delete(space);
      }
    },
    spaces: () => [...records.values()].map(spaceInfo),

    clients: () => [...connected.values()].map(clientInfo),
    approve: async () => notImplemented('approval mode'),
    deny: async () => notImplemented('approval mode'),
    block: async () => notImplemented('blocking'),
    unblock: async () => notImplemented('blocking'),
    async disconnect(device) {
      const p = connected.get(device);
      if (p) await link.disconnect(p.id, 'owner');
    },

    async storage() {
      const u = await store.usage();
      let oldest: number | undefined;
      for (const r of records.values()) for await (const x of store.listIds(r.space)) oldest = oldest === undefined ? x.receivedAt : Math.min(oldest, x.receivedAt);
      return { usedBytes: u.total, limitBytes: settings.storageLimitBytes, perSpace: u.perSpace, ...(oldest !== undefined ? { oldestPacketAt: oldest } : {}) };
    },
    on(h) {
      handlers.add(h);
      return () => void handlers.delete(h);
    },
  };
  return hub;
}
