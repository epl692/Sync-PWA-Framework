import type { CoreEvent } from '../types';
import type { StorageAdapter } from './types';

const PRESSURE_RATIO = 0.9;
const CHECK_EVERY_MS = 30_000;

/** Watches storage use and raises `storage:pressure` (R-09). Best effort: not every platform can estimate. */
export class QuotaMonitor {
  private lastCheck = 0;

  constructor(
    private readonly storage: StorageAdapter,
    private readonly emit: (e: CoreEvent) => void,
    private readonly now: () => number,
  ) {}

  /** Ask the platform not to evict our data. */
  async requestPersistence(): Promise<void> {
    try {
      await this.storage.persist?.();
    } catch {
      // unsupported or denied; sync continues
    }
  }

  /** Cheap, throttled check after writes. */
  async checkSoon(): Promise<void> {
    const t = this.now();
    if (t - this.lastCheck < CHECK_EVERY_MS) return;
    this.lastCheck = t;
    await this.check();
  }

  async check(): Promise<void> {
    try {
      const est = await this.storage.estimate?.();
      if (est && est.quotaBytes > 0 && est.usageBytes / est.quotaBytes >= PRESSURE_RATIO) {
        this.emit({ kind: 'storage:pressure', usageBytes: est.usageBytes, quotaBytes: est.quotaBytes });
      }
    } catch {
      // ignore
    }
  }

  /** A write failed because the quota was exceeded: always tell the app. */
  async reportExceeded(): Promise<void> {
    let usageBytes = 0;
    let quotaBytes = 0;
    try {
      const est = await this.storage.estimate?.();
      if (est) ({ usageBytes, quotaBytes } = est);
    } catch {
      // ignore
    }
    this.emit({ kind: 'storage:pressure', usageBytes, quotaBytes });
  }
}
