import type { StorageAdapter, StorageTx } from '../storage/types';
import type { SpaceId } from '../types';

/** Locally authored packets not yet confirmed by enough peers. */
export interface OutboxEntry {
  packetId: string;
  space: SpaceId;
  createdAt: number;
  confirmedBy: string[];
}

export function newOutboxEntry(packetId: string, space: SpaceId, createdAt: number): OutboxEntry {
  return { packetId, space, createdAt, confirmedBy: [] };
}

export async function addOutbox(tx: StorageTx, entry: OutboxEntry): Promise<void> {
  await tx.put('outbox', entry.packetId, entry);
}

export async function listOutbox(storage: StorageAdapter): Promise<OutboxEntry[]> {
  return storage.transaction(['outbox'], 'readonly', async (tx) => {
    const out: OutboxEntry[] = [];
    for await (const { value } of tx.scan<OutboxEntry>('outbox')) out.push(value);
    return out;
  });
}

/**
 * Record that `peerId` confirmed these packets. An entry is removed once `threshold` distinct peers
 * confirmed it. Packets stay in the log regardless.
 */
export async function confirmOutbox(
  storage: StorageAdapter,
  packetIds: readonly string[],
  peerId: string,
  threshold: number,
): Promise<number> {
  return storage.transaction(['outbox'], 'readwrite', async (tx) => {
    let cleared = 0;
    for (const id of packetIds) {
      const e = await tx.get<OutboxEntry>('outbox', id);
      if (!e) continue;
      if (!e.confirmedBy.includes(peerId)) e.confirmedBy.push(peerId);
      if (e.confirmedBy.length >= threshold) {
        await tx.delete('outbox', id);
        cleared++;
      } else {
        await tx.put('outbox', id, e);
      }
    }
    return cleared;
  });
}
