/**
 * Retention and capacity (spec FR-009): at start, hourly, and shortly after packets arrive, delete expired day shards and, when
 * storage is over its limit, evict delivered packets (oldest first) before undelivered ones. The owner is warned before anything
 * undelivered is lost.
 */

import { pruneExpiredKeys } from './access/codes';
import type { RelayHub } from './relay/relayHub';
import type { EnforceResult, HubStore } from './store/types';
import type { Timers } from './link/server';
import type { HubEvent, HubSettings, ServedSpaceRecord, SpaceId } from './types';

export const RETENTION_INTERVAL_MS = 60 * 60_000;
export const NEAR_LIMIT_FRACTION = 0.9;
const POKE_DELAY_MS = 5_000;

export interface RetentionOptions {
  store: HubStore;
  relay: RelayHub;
  settings(): HubSettings;
  records(): Iterable<ServedSpaceRecord>;
  now(): number;
  timers: Timers;
  emit(e: HubEvent): void;
  /** Called with the fresh per-Space usage after every run. */
  onUsage?(perSpace: Record<SpaceId, number>): void;
}

export class Retention {
  private interval: unknown;
  private poked: unknown;
  private running: Promise<EnforceResult> | undefined;
  private nearLimitWarned = false;

  constructor(private readonly o: RetentionOptions) {}

  start(): void {
    this.interval = this.o.timers.setInterval(() => void this.run().catch(() => undefined), RETENTION_INTERVAL_MS);
  }

  stop(): void {
    this.o.timers.clearInterval(this.interval);
    this.o.timers.clearTimeout(this.poked);
    this.poked = undefined;
  }

  /** Run soon (packets just arrived); many pokes become one run. */
  poke(): void {
    if (this.poked !== undefined) return;
    this.poked = this.o.timers.setTimeout(() => {
      this.poked = undefined;
      void this.run().catch(() => undefined);
    }, POKE_DELAY_MS);
  }

  run(): Promise<EnforceResult> {
    this.running = (this.running ?? Promise.resolve({} as EnforceResult)).then(() => this.once(), () => this.once());
    return this.running;
  }

  private async once(): Promise<EnforceResult> {
    const s = this.o.settings();
    const now = this.o.now();
    for (const r of this.o.records()) if (pruneExpiredKeys(r, now)) await this.o.store.putSpace(r).catch(() => undefined);
    const res = await this.o.store.enforce({ now, retentionDays: s.retentionDays, limitBytes: s.storageLimitBytes });
    for (const d of res.dropped) this.o.relay.dropPacket(d.space, d.id);
    const usage = await this.o.store.usage();
    this.o.onUsage?.(usage.perSpace);
    if (res.evictedUndelivered > 0) {
      this.o.emit({ type: 'storage-warning', level: 'evicting-undelivered', bytes: usage.total });
    } else if (usage.total >= s.storageLimitBytes * NEAR_LIMIT_FRACTION) {
      if (!this.nearLimitWarned) this.o.emit({ type: 'storage-warning', level: 'near-limit', bytes: usage.total });
      this.nearLimitWarned = true;
    } else {
      this.nearLimitWarned = false;
    }
    return res;
  }
}
