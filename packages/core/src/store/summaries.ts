import { containsValue, type Interval } from '../sync/intervals';
import type { StorageAdapter } from '../storage/types';
import type { DeviceId, SpaceId } from '../types';

export type Held = Record<DeviceId, Interval[]>;

export interface SummaryRecord {
  space: SpaceId;
  held: Held;
}

/** In-memory mirror of the `summary` store: which packets (author, seq) this device holds, per Space. */
export class SummaryCache {
  private spaces = new Map<SpaceId, Held>();

  constructor(private readonly storage: StorageAdapter) {}

  async ensure(space: SpaceId): Promise<Held> {
    let h = this.spaces.get(space);
    if (!h) {
      const rec = await this.storage.transaction(['summary'], 'readonly', (tx) => tx.get<SummaryRecord>('summary', space));
      h = rec?.held ?? {};
      this.spaces.set(space, h);
    }
    return h;
  }

  /** Call only after the transaction that wrote the record has committed. */
  commit(rec: SummaryRecord): void {
    this.spaces.set(rec.space, rec.held);
  }

  has(space: SpaceId, author: DeviceId, seq: number): boolean {
    return containsValue(this.spaces.get(space)?.[author] ?? [], seq);
  }

  maxSeq(space: SpaceId, author: DeviceId): number {
    const iv = this.spaces.get(space)?.[author];
    return iv && iv.length ? iv[iv.length - 1]![1] : 0;
  }

  snapshot(space: SpaceId): Held {
    return structuredClone(this.spaces.get(space) ?? {});
  }
}
