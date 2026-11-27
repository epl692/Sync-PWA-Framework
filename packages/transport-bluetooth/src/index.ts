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
export { defaultBluetooth, GattError, type BluetoothLike, type DeviceLike } from './webBluetooth';

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
  const connections = () => [...links.values()].map((l) => l.link.info);
  const notifyConns = () => {
    const c = connections();
    for (const h of [...connChange]) h(c);
  };

  async function connectDevice(device: Parameters<typeof openGattLink>[0]): Promise<HubConnectionInfo> {
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
      onClosed: (reason) => {
        const entry = [...links.entries()].find(([, v]) => v.link === link);
        if (entry) {
          links.delete(entry[0]);
          emit('peerDisconnected', entry[1].peerId, reason);
        }
        setStatus(links.size ? { kind: 'ready' } : { kind: 'needs-hub', message: 'Find a Hub to sync with.' });
        notifyConns();
      },
    });
    let info: HubConnectionInfo;
    try {
      info = await link.connect();
    } catch (e) {
      if (e instanceof HubLinkError) {
        if (e.code === 'busy') setStatus({ kind: 'full', hub: gatt.name, retryAfterMs: e.retryMs ?? 5000 });
        emit('error', { code: e.code, message: e.message });
      } else {
        emit('error', { code: 'connect-failed', message: (e as Error).message });
      }
      throw e;
    }
    peerId = `hub:${info.fingerprint}`;
    const previous = links.get(info.fingerprint);
    if (previous) previous.link.close('replaced');
    links.set(info.fingerprint, { link, peerId });
    const peer: PeerInfo = { id: peerId, label: info.name };
    setStatus({ kind: 'ready' });
    emit('peerConnected', peer);
    notifyConns();
    return info;
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
      for (const { link } of [...links.values()]) link.close('stopped');
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
      links.get(fingerprint)?.link.close('disconnected');
    },
    async forgetHub(fingerprint) {
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
