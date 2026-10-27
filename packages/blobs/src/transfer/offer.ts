/**
 * Upload is "offer to peers, the receiver pulls" (research R-07). A device offers each complete blob it holds to every
 * lane peer that syncs the blob's Space and has not already confirmed it (`stored`). Attaching offline needs nothing
 * special: the offer happens when a peer appears.
 */

import type { Engine } from '../engine';
import type { PeerTable } from './peers';
import type { StoredBlob } from '../types';

export class OfferSender {
  constructor(
    private readonly e: Engine,
    private readonly peers: PeerTable,
  ) {}

  private wanted(rec: StoredBlob, peerKey: string): boolean {
    const st = this.peers.state(peerKey);
    // A relay that holds data for everyone ("*") is a cache that may have dropped the blob since it confirmed it
    // (research R-08), so it is offered everything again; any other peer only what it has not confirmed.
    const relayLike = this.peers.info(peerKey)?.spaces.includes('*') ?? false;
    return !!rec.complete && (relayLike || !rec.replicas.includes(peerKey)) && !st?.rejected.has(rec.id) && this.peers.shares(peerKey, rec.space);
  }

  /** Offer everything this device holds to one peer (when it becomes ready). */
  async offerAll(peerKey: string): Promise<void> {
    for await (const rec of this.e.storage.listBlobs({ orderBy: 'createdAt' })) {
      if (this.e.closed) return;
      if (this.wanted(rec, peerKey)) await this.send(peerKey, rec);
    }
  }

  /** Offer one blob to every ready peer that syncs its Space (after an attach or a completed download). */
  async offerBlob(id: string): Promise<void> {
    const rec = await this.e.storage.getBlob(id);
    if (!rec) return;
    for (const p of this.peers.ready()) if (this.wanted(rec, p.key)) await this.send(p.key, rec);
  }

  private send(peerKey: string, rec: StoredBlob): Promise<boolean> {
    return this.peers.send(peerKey, { type: 'offer', space: rec.space, id: rec.id, size: rec.size });
  }
}
