/** Notices newer runtime modules while the app is open, without replacing anything that is running (research R-08). */

import type { HostEvent } from '../types';
import type { RuntimeLoader } from './runtime';

export interface UpdateCheckerOptions {
  runtime: RuntimeLoader;
  /** Versions of the runtime modules that are running now. */
  activeVersions(): ReadonlyMap<string, string>;
  emit(e: HostEvent): void;
  now?: () => number;
  /** Minimum time between automatic checks. Default 5 minutes. */
  minIntervalMs?: number;
}

export class UpdateChecker {
  private last = Number.NEGATIVE_INFINITY;
  private readonly announced = new Set<string>();
  private running?: Promise<void>;

  constructor(private readonly o: UpdateCheckerOptions) {}

  /**
   * Fetch the manifest; for every module whose listed version differs from the running one, fetch, verify and
   * cache the file and announce it once. `force` skips the rate limit (a person asked).
   */
  check(force = false): Promise<void> {
    const now = (this.o.now ?? Date.now)();
    if (!force && now - this.last < (this.o.minIntervalMs ?? 5 * 60_000)) return Promise.resolve();
    if (this.running) return this.running;
    this.last = now;
    this.running = this.run().finally(() => void (this.running = undefined));
    return this.running;
  }

  private async run(): Promise<void> {
    const fresh = await this.o.runtime.fetchManifest();
    if (!fresh || fresh.unsupported) return;
    const active = this.o.activeVersions();
    for (const entry of fresh.entries) {
      if (active.get(entry.id) === entry.version) continue;
      const key = `${entry.id}@${entry.version}`;
      if (this.announced.has(key)) continue;
      if (await this.o.runtime.prefetch(entry)) {
        this.announced.add(key);
        this.o.emit({ kind: 'module:update-available', id: entry.id, version: entry.version });
      }
    }
    await this.o.runtime.prune(fresh);
  }

  /** Check when the device comes back online or the page becomes visible. */
  attach(target: { addEventListener(type: string, cb: () => void): void }, doc: { visibilityState?: string; addEventListener(type: string, cb: () => void): void }): void {
    target.addEventListener('online', () => void this.check());
    doc.addEventListener('visibilitychange', () => {
      if (doc.visibilityState !== 'hidden') void this.check();
    });
  }
}

/**
 * The fresh manifest and the newer files are already in the loader's cache, so the next launch loads them.
 * Nothing running is swapped (custom elements cannot be redefined); this exists so `applyUpdate` has one place to call.
 */
export async function applyModuleUpdates(): Promise<void> {}
