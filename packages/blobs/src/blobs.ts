/** `createBlobs`: the composition root. Wires storage, keys, the lane, status and the transfer modules into the `Blobs` API. */

import type { SyncCore } from '@sync/core';
import type { BlobKeys } from '@sync/spaces';
import { attach, cleanPartials } from './attach/attach';
import { resolveConfig } from './config';
import { keyProviderFrom, type KeyProvider } from './crypto/keys';
import { openBlob, toBlob } from './crypto/open';
import type { Engine } from './engine';
import { LANE_MAGIC } from './format/constants';
import { validateRef } from './format/ref';
import { decodeMessage } from './protocol/codec';
import { Policy } from './policy/policy';
import { Gc } from './refs/gc';
import { RefIndex } from './refs';
import { startPrefetch } from './refs/watch';
import { Server } from './serve/serve';
import { BlobEmitter } from './status/events';
import { StatusHub } from './status/status';
import { createIndexedDbBlobStorage } from './storage/indexeddb';
import { OfferSender } from './transfer/offer';
import { PeerTable } from './transfer/peers';
import { Replicas } from './transfer/replicas';
import { Scheduler } from './transfer/scheduler';
import type { BlobStorage, Blobs, BlobsConfig } from './types';

export interface CreateBlobsOptions {
  core: SyncCore;
  /** `spaces.blobKeys` from @sync/spaces (S-1). */
  keys?: BlobKeys;
  /** Alternative to `keys`: an already adapted provider (tests). */
  keyProvider?: KeyProvider;
  /** Defaults to IndexedDB in browsers. */
  storage?: BlobStorage;
  config?: BlobsConfig;
}

export async function createBlobs(opts: CreateBlobsOptions): Promise<Blobs> {
  const cfg = resolveConfig(opts.config);
  const keys = opts.keyProvider ?? (opts.keys ? keyProviderFrom(opts.keys) : undefined);
  if (!keys) throw new TypeError('createBlobs needs `keys` (spaces.blobKeys) or `keyProvider`');
  const storage = opts.storage ?? (await createIndexedDbBlobStorage());
  const events = new BlobEmitter();
  const status = new StatusHub(() => storage);
  const e = { core: opts.core, lane: opts.core.lane(LANE_MAGIC), keys, storage, cfg, events, status, leases: new Map(), now: cfg.now, closed: false } as unknown as Engine;

  e.peers = new PeerTable(e, {
    onReady: (key) => {
      void e.offers.offerAll(key).catch(() => undefined);
      e.scheduler.onPeerReady(key);
    },
    onGone: (key) => {
      e.scheduler.onPeerGone(key);
      e.serve.onPeerGone(key);
    },
  });
  e.offers = new OfferSender(e, e.peers);
  e.replicas = new Replicas(e, e.peers);
  e.scheduler = new Scheduler(e);
  e.serve = new Server(e);
  e.refs = new RefIndex(e);
  e.gc = new Gc(e, e.refs);
  e.policy = new Policy(e);
  e.replicas.hooks.wants = (id) => e.scheduler.wants(id);
  e.replicas.hooks.onWantedOffer = async (peer, m) => {
    e.scheduler.onOffer(peer, m);
    return true;
  };

  const offLane = e.lane.onMessage((peerKey, bytes) => {
    const d = decodeMessage(bytes);
    if (!d.ok || 'unknown' in d) return;
    const m = d.msg;
    // a peer that speaks another blob protocol version is treated as having no blob lane: nothing it sends is acted on
    const hello = e.peers.state(peerKey)?.hello;
    if (m.type !== 'hello' && hello && hello.v !== 1) return;
    const swallow = (p: Promise<unknown>) => void p.catch(() => undefined);
    switch (m.type) {
      case 'hello':
        return e.peers.onHello(peerKey, m);
      case 'offer':
        return swallow(e.replicas.onOffer(peerKey, m));
      case 'stored':
        return swallow(e.replicas.onStored(peerKey, m.id));
      case 'reject':
        e.replicas.onReject(peerKey, m.id);
        return e.scheduler.onReject(peerKey, m.id, m.reason);
      case 'get':
        return e.serve.onGet(peerKey, m);
      case 'cancel':
        return e.serve.onCancel(peerKey, m.id);
      case 'manifest':
        return swallow(e.scheduler.onManifest(peerKey, m));
      case 'chunk':
        return swallow(e.scheduler.onChunk(peerKey, m));
      case 'miss':
        return e.scheduler.onMiss(peerKey, m);
    }
  });
  e.peers.start();
  await e.refs.start();
  e.gc.start();
  e.policy.start();
  const stopPrefetch = startPrefetch(e);
  await cleanPartials(e).catch(() => undefined);

  return {
    async attach(source, o) {
      const ref = await attach(e, source, o);
      void e.offers.offerBlob(ref.id).catch(() => undefined);
      void e.policy.evict().catch(() => undefined); // a new blob may push the device over its budget
      return ref;
    },
    observe: (ref) => status.observe(ref),
    request: (ref, o) => e.scheduler.request(ref, o),
    open: (ref, o) => {
      const v = validateRef(ref, { maxBlobBytes: cfg.maxBlobBytes });
      if (!v.ok) return Promise.reject(new TypeError(`not a usable blob reference: ${v.reason}`));
      return openBlob(e, ref, o);
    },
    toBlob: (ref, o) => toBlob(e, ref, o),
    cancel: (ref) => e.scheduler.cancel(ref.id),
    pin: (ref) => e.policy.pin(ref),
    unpin: (ref) => e.policy.unpin(ref),
    usage: () => e.policy.usage(),
    evict: (o) => e.policy.evict(o),
    collect: () => e.gc.collect(),
    reindex: () => e.refs.reindex(),
    on: (event, handler) => events.on(event, handler),
    async close() {
      e.closed = true;
      offLane();
      stopPrefetch();
      e.gc.stop();
      e.policy.stop();
      await e.refs.stop();
      e.scheduler.close();
      e.peers.stop();
    },
  } as Blobs;
}
