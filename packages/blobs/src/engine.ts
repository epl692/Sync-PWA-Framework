/** The engine context shared by the attach, transfer, serve, refs and policy modules. Built once by `createBlobs`. */

import type { Lane, SyncCore } from '@sync/core';
import type { ResolvedConfig } from './config';
import type { KeyProvider } from './crypto/keys';
import type { BlobEmitter } from './status/events';
import type { StatusHub } from './status/status';
import type { Policy } from './policy/policy';
import type { Gc } from './refs/gc';
import type { RefIndex } from './refs';
import type { Server } from './serve/serve';
import type { OfferSender } from './transfer/offer';
import type { PeerTable } from './transfer/peers';
import type { Replicas } from './transfer/replicas';
import type { Scheduler } from './transfer/scheduler';
import type { BlobStorage } from './types';

export interface Engine {
  readonly core: SyncCore;
  readonly lane: Lane;
  readonly keys: KeyProvider;
  readonly storage: BlobStorage;
  readonly cfg: ResolvedConfig;
  readonly events: BlobEmitter;
  readonly status: StatusHub;
  peers: PeerTable;
  offers: OfferSender;
  replicas: Replicas;
  scheduler: Scheduler;
  serve: Server;
  refs: RefIndex;
  gc: Gc;
  policy: Policy;
  /** Open streams and active downloads per blob ID: eviction never touches a leased blob. */
  readonly leases: Map<string, number>;
  now(): number;
  closed: boolean;
}
