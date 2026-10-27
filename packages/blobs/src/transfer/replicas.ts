/**
 * Handling of incoming `offer`, `stored` and `reject`, and replica recording. `replicas` is this device's belief about
 * who holds a full copy; it protects unreplicated blobs from eviction (research R-10).
 */

import type { Engine } from '../engine';
import type { LaneMsg } from '../protocol/codec';
import type { PeerTable } from './peers';

export const MAX_REPLICAS = 16;

export interface ReplicaHooks {
  /** A peer offered a blob this device does not hold. Return true if it was wanted and a fetch was started. */
  onWantedOffer?(peerKey: string, offer: Extract<LaneMsg, { type: 'offer' }>): Promise<boolean>;
  /** Is this blob wanted (requested, or matching the prefetch rule)? Decided before answering an offer. */
  wants?(id: string): boolean;
}

export class Replicas {
  readonly hooks: ReplicaHooks = {};

  constructor(
    private readonly e: Engine,
    private readonly peers: PeerTable,
  ) {}

  /** `stored`: the peer holds a complete, verified copy. */
  async onStored(peerKey: string, id: string): Promise<void> {
    const rec = await this.e.storage.getBlob(id);
    if (!rec) return;
    if (rec.replicas.includes(peerKey)) return;
    const replicas = [...rec.replicas, peerKey].slice(-MAX_REPLICAS);
    await this.e.storage.putBlob({ ...rec, replicas });
    this.e.status.update(id, { replicas: replicas.length });
  }

  /** `reject`: stop offering this blob to that peer for the rest of the session. */
  onReject(peerKey: string, id: string): void {
    this.peers.state(peerKey)?.rejected.add(id);
  }

  /**
   * `offer`: answer `stored` if this device already holds a complete copy, start a fetch only if the blob was asked for
   * (FR-011), and otherwise ignore it. An ignored offer is not an error: the offerer simply tries again later.
   */
  async onOffer(peerKey: string, m: Extract<LaneMsg, { type: 'offer' }>): Promise<void> {
    if (!this.peers.allowOffer(peerKey)) return; // flood: dropped
    const rec = await this.e.storage.getBlob(m.id);
    if (rec?.complete) {
      await this.peers.send(peerKey, { type: 'stored', id: m.id });
      return;
    }
    if (this.hooks.wants?.(m.id) && this.peers.shares(peerKey, m.space)) await this.hooks.onWantedOffer?.(peerKey, m);
  }
}
