/**
 * Bluetooth transport (spec 005): browser clients sync through a nearby Hub over Web Bluetooth. Implements the 001 `Transport`
 * contract unchanged; every connected Hub is one peer (`hub:<fingerprint>`). See contracts/transport-bluetooth.ts.
 */

import type { PeerInfo, Transport, TransportCapabilities, TransportEvents, TransportState } from '@sync/core';
import { ClientLink, HubLinkError, type ClientTimers, type HubCandidate, type HubConnectionInfo } from './clientLink';
import type { HubProofProvider } from './proofs';
import { checkSupport, toTransportState, type BluetoothTransportStatus } from './status';
import { createIndexedDbTrustStore, createMemoryTrustStore, type TrustedHub, type TrustedHubStore } from './trustStore';
import { defaultBluetooth, openGattLink, requestHub, GattError, type BluetoothLike } from './webBluetooth';

export { HubLinkError } from './clientLink';
export type { HubCandidate, HubConnectionInfo, HubConnectionState, ClientTimers } from './clientLink';
export type { HubProofProvider } from './proofs';
export { checkSupport, describeStatus, toTransportState, type BluetoothTransportStatus } from './status';
export { createIndexedDbTrustStore, createMemoryTrustStore, type TrustedHub, type TrustedHubStore, type PinnedHub } from './trustStore';
export { defaultBluetooth, openGattLink, requestHub, GattError, type BluetoothLike, type DeviceLike, type GattLink } from './webBluetooth';

/** Preferred message size: the core batches to this (capabilities.maxMessageBytes). Larger messages are framed and still carried. */
export const UNFRAMED_MESSAGE_BYTES = 512 * 1024;
/** Hard limit a peer may send (the 001 default of 4 MiB); over-limit messages are rejected. */
export const DEFAULT_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_BLOB_CEILING_BYTES = 5 * 1024 * 1024;

export interface BluetoothTransportOptions {
  proofs: HubProofProvider;
  /** Persists pinned Hubs. Default: IndexedDB database `sync-bluetooth-v1`, or memory where that is unavailable. */
  trustStore?: TrustedHubStore;
  /** Called on first contact with a Hub; resolve true if the user confirms the shown fingerprint and name. */
  confirmHub(hub: HubCandidate): Promise<boolean>;
  /** Spaces to prove; default every Space the proof provider offers. */
  spaces?: string[];
  autoReconnect?: boolean;
  /** Blob auto-transfer ceiling for the blob module (research R-05). Default 5 MiB. */
  blobCeilingBytes?: number;
  /** `maxMessageBytes` is the hard limit on a received message (default 4 MiB, the 001 limit). */
  limits?: { maxMessageBytes?: number };
  /** Automatic reconnection to pinned Hubs after a dropout (needs `getDevices()`; otherwise the app shows a one-tap button). */
  reconnect?: { minMs?: number; maxMs?: number; maxAttempts?: number };
  /** Injection points for tests. Default: the browser's Bluetooth. */
  bluetooth?: BluetoothLike;
  now?: () => number;
  timers?: ClientTimers;
  isSecureContext?: boolean;
}

export interface BluetoothTransport extends Transport {
  readonly id: 'bluetooth';
  readonly blobCeilingBytes: number;
  status(): BluetoothTransportStatus;
  /** Show the browser's device chooser filtered to Hubs and connect. MUST be called from a user gesture. */
  chooseHub(): Promise<HubConnectionInfo>;
  disconnectHub(fingerprint: string): Promise<void>;
  /**
   * Reconnect to a pinned Hub without the chooser, where the browser allows it. Rejects with `needs-gesture` where it does not
   * (then call `chooseHub()` from a user gesture).
   */
  reconnect(fingerprint: string): Promise<HubConnectionInfo>;
  /** Forget the pin. The next contact asks the user to confirm again. */
  forgetHub(fingerprint: string): Promise<void>;
  trustedHubs(): Promise<TrustedHub[]>;
  connections(): HubConnectionInfo[];
  onConnections(handler: (c: HubConnectionInfo[]) => void): () => void;
  onStatus(handler: (s: BluetoothTransportStatus) => void): () => void;
  onIdentityChanged(handler: (info: { fingerprint: string; name: string }) => void): () => void;
}

type Handlers = { [K in keyof TransportEvents]: Set<TransportEvents[K]> };

export function createBluetoothTransport(opts: BluetoothTransportOptions): BluetoothTransport {
  const maxMessageBytes = opts.limits?.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  const bt = opts.bluetooth ?? defaultBluetooth();
  const trust = opts.trustStore ?? (typeof indexedDB !== 'undefined' ? createIndexedDbTrustStore() : createMemoryTrustStore());
  const capabilities: TransportCapabilities = { maxMessageBytes: Math.min(UNFRAMED_MESSAGE_BYTES, maxMessageBytes), ordered: true, multiPeer: true, blobs: false };

  const handlers: Handlers = { state: new Set(), peerConnected: new Set(), peerDisconnected: new Set(), message: new Set(), error: new Set() };
  const connChange = new Set<(c: HubConnectionInfo[]) => void>();
  const statusChange = new Set<(s: BluetoothTransportStatus) => void>();
  const identityChange = new Set<(i: { fingerprint: string; name: string }) => void>();
  const links = new Map<string, { link: ClientLink; peerId: string }>();
  /** Radio links that are closing: a new connection to the same device waits, or it would be torn down by the old close. */
  const releasing = new Map<string, Promise<void>>();
  /** Links still being set up (securing, waiting for owner approval): shown to the user like connected ones. */
  const connecting = new Set<ClientLink>();
  /** Hubs the user disconnected or forgot, and Hubs we are reconnecting to. */
  const noReconnect = new Set<string>();
  const retrying = new Map<string, { timer: unknown; attempt: number }>();
  const rc = { minMs: opts.reconnect?.minMs ?? 1000, maxMs: opts.reconnect?.maxMs ?? 30_000, maxAttempts: opts.reconnect?.maxAttempts ?? 12 };
  const sleepTimers = opts.timers;
  const setT = (fn: () => void, ms: number) => (sleepTimers ? sleepTimers.setTimeout(fn, ms) : setTimeout(fn, ms));
  const clearT = (h: unknown) => (sleepTimers ? sleepTimers.clearTimeout(h) : clearTimeout(h as never));
  const TRANSIENT = new Set(['disconnected', 'keepalive', 'write-failed', 'resync-failed', 'hub-error', 'bye', 'error', 'timeout']);
  let state: TransportState = 'idle';
  let status: BluetoothTransportStatus = { kind: 'needs-hub', message: 'Find a Hub to sync with.' };

  const support = () => checkSupport({ bluetooth: bt, isSecureContext: opts.isSecureContext ?? (globalThis as { isSecureContext?: boolean }).isSecureContext });

  const emit = <K extends keyof TransportEvents>(e: K, ...a: Parameters<TransportEvents[K]>) => {
    for (const h of [...handlers[e]]) (h as (...x: unknown[]) => void)(...a);
  };
  const setStatus = (s: BluetoothTransportStatus, detail?: string) => {
    status = s;
    const next = toTransportState(s, links.size > 0);
    if (next !== state) {
      state = next;
      emit('state', state, detail);
    }
    for (const h of [...statusChange]) h(s);
  };
  const connections = () => [...links.values()].map((l) => l.link.info).concat([...connecting].map((l) => l.info));
  const notifyConns = () => {
    const c = connections();
    for (const h of [...connChange]) h(c);
  };

  async function connectDevice(device: Parameters<typeof openGattLink>[0]): Promise<HubConnectionInfo> {
    await releasing.get(device.id);
    const gatt = await openGattLink(device);
    let peerId = '';
    const link: ClientLink = new ClientLink({
      gatt,
      proofs: opts.proofs,
      trust,
      confirmHub: opts.confirmHub,
      ...(opts.spaces ? { spaces: opts.spaces } : {}),
      maxMessageBytes,
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.timers ? { timers: opts.timers } : {}),
      onCore: (bytes) => emit('message', peerId, bytes),
      onState: () => notifyConns(),
      onIdentityChanged: (i) => {
        for (const h of [...identityChange]) h(i);
      },
      onResync: () => {
        if (!peerId) return;
        emit('peerDisconnected', peerId, 'resync');
        emit('peerConnected', { id: peerId, label: link.info.name });
      },
      onClosed: (reason) => {
        releasing.set(gatt.id, link.released);
        void link.released.then(() => {
          if (releasing.get(gatt.id) === link.released) releasing.delete(gatt.id);
        });
        const entry = [...links.entries()].find(([, v]) => v.link === link);
        if (entry) {
          links.delete(entry[0]);
          emit('peerDisconnected', entry[1].peerId, reason);
        }
        setStatus(links.size ? { kind: 'ready' } : { kind: 'needs-hub', message: 'Find a Hub to sync with.' });
        notifyConns();
        if (entry && TRANSIENT.has(reason) && !noReconnect.has(entry[0])) scheduleReconnect(entry[0]);
      },
    });
    let info: HubConnectionInfo;
    connecting.add(link);
    notifyConns();
    try {
      info = await link.connect();
      connecting.delete(link);
    } catch (e) {
      connecting.delete(link);
      notifyConns();
      if (e instanceof HubLinkError) {
        if (e.code === 'busy') setStatus({ kind: 'full', hub: gatt.name, retryAfterMs: e.retryMs ?? 5000 });
        emit('error', { code: e.code, message: e.message });
      } else {
        emit('error', { code: 'connect-failed', message: (e as Error).message });
      }
      throw e;
    }
    peerId = `hub:${info.fingerprint}`;
    noReconnect.delete(info.fingerprint);
    const previous = links.get(info.fingerprint);
    if (previous) previous.link.close('replaced');
    links.set(info.fingerprint, { link, peerId });
    const peer: PeerInfo = { id: peerId, label: info.name };
    setStatus({ kind: 'ready' });
    emit('peerConnected', peer);
    notifyConns();
    return info;
  }

  async function pinnedDevice(fingerprint: string) {
    const pin = await trust.get(fingerprint);
    if (!pin?.browserDeviceId || !bt?.getDevices) return undefined;
    return (await bt.getDevices()).find((d) => d.id === pin.browserDeviceId);
  }

  async function reconnectNow(fingerprint: string): Promise<HubConnectionInfo> {
    const device = await pinnedDevice(fingerprint);
    if (!device) throw new GattError('no-hub', 'needs-gesture');
    return connectDevice(device);
  }

  /** Back off with jitter, honor a full Hub's retry hint, and stop for good once the user disconnects or forgets the Hub. */
  function scheduleReconnect(fingerprint: string, hintMs?: number): void {
    if (noReconnect.has(fingerprint) || opts.autoReconnect === false) return;
    const prev = retrying.get(fingerprint);
    if (prev) clearT(prev.timer);
    const attempt = (prev?.attempt ?? 0) + 1;
    if (attempt > rc.maxAttempts) {
      retrying.delete(fingerprint);
      setStatus({ kind: 'needs-hub', message: 'The Hub could not be reached. Press the button to try again.' });
      return;
    }
    const base = Math.min(rc.maxMs, rc.minMs * 2 ** (attempt - 1));
    const delay = Math.max(hintMs ?? 0, Math.round(base * (0.8 + Math.random() * 0.4)));
    const timer = setT(() => {
      if (noReconnect.has(fingerprint) || links.has(fingerprint)) return void retrying.delete(fingerprint);
      reconnectNow(fingerprint).then(
        () => void retrying.delete(fingerprint),
        (e) => {
          if ((e as { message?: string }).message === 'needs-gesture') {
            retrying.delete(fingerprint);
            setStatus({ kind: 'needs-hub', message: 'Press "Find a Hub" to reconnect.' });
          } else if (!noReconnect.has(fingerprint)) {
            scheduleReconnect(fingerprint, (e as { retryMs?: number }).retryMs);
          }
        },
      );
    }, delay);
    retrying.set(fingerprint, { timer, attempt });
  }

  const t: BluetoothTransport = {
    id: 'bluetooth',
    capabilities,
    blobCeilingBytes: opts.blobCeilingBytes ?? DEFAULT_BLOB_CEILING_BYTES,
    get state() {
      return state;
    },
    supported() {
      const s = support();
      return s.ok ? { ok: true } : { ok: false, reason: s.reason };
    },
    status: () => status,

    async start() {
      const s = support();
      if (!s.ok) {
        status = s.status;
        if (state !== 'unsupported') {
          state = 'unsupported';
          emit('state', state, s.reason);
        }
        return;
      }
      setStatus({ kind: 'needs-hub', message: 'Find a Hub to sync with.' });
    },

    async stop() {
      for (const fp of links.keys()) noReconnect.add(fp);
    for (const r of retrying.values()) clearT(r.timer);
    retrying.clear();
    for (const { link } of [...links.values()]) link.close('stopped');
    for (const link of [...connecting]) link.close('stopped');
      links.clear();
      if (state !== 'unsupported') {
        state = 'idle';
        emit('state', state);
      }
    },

    async send(peerId, bytes) {
      const entry = [...links.values()].find((l) => l.peerId === peerId);
      if (!entry) throw new Error(`peer ${peerId} is not connected`);
      await entry.link.send(bytes);
    },

    async chooseHub() {
      const s = support();
      if (!s.ok) throw new GattError('no-hub', s.reason);
      const device = await requestHub(bt!);
      return connectDevice(device);
    },

    async disconnectHub(fingerprint) {
      noReconnect.add(fingerprint);
      const r = retrying.get(fingerprint);
      if (r) clearT(r.timer);
      retrying.delete(fingerprint);
      links.get(fingerprint)?.link.close('user');
    },
    reconnect(fingerprint) {
      noReconnect.delete(fingerprint);
      return reconnectNow(fingerprint).catch((e) => {
        if ((e as { message?: string }).message === 'needs-gesture') throw Object.assign(new GattError('no-hub', 'Press "Find a Hub" to reconnect.'), { code: 'needs-gesture' });
        throw e;
      });
    },
    async forgetHub(fingerprint) {
      noReconnect.add(fingerprint);
      const r = retrying.get(fingerprint);
      if (r) clearT(r.timer);
      retrying.delete(fingerprint);
      links.get(fingerprint)?.link.close('forgotten');
      await trust.forget(fingerprint);
    },
    trustedHubs: () => trust.list(),
    connections,
    onConnections(h) {
      connChange.add(h);
      return () => void connChange.delete(h);
    },
    onStatus(h) {
      statusChange.add(h);
      return () => void statusChange.delete(h);
    },
    onIdentityChanged(h) {
      identityChange.add(h);
      return () => void identityChange.delete(h);
    },

    on(event, handler) {
      (handlers[event] as Set<unknown>).add(handler);
      return () => void (handlers[event] as Set<unknown>).delete(handler);
    },
  };
  return t;
}
export { errorMessage } from './status';
