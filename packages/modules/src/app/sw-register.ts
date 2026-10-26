/** Registers the generated service worker and reports its lifecycle (contracts/pwa-output.md). */

import type { HostEvent } from '../types';

/** The slices of the service worker API used here, so they can be faked. */
export interface WorkerLike {
  state: string;
  addEventListener(type: 'statechange', cb: () => void): void;
  postMessage(msg: unknown): void;
}
export interface RegistrationLike {
  installing: WorkerLike | null;
  waiting: WorkerLike | null;
  active: WorkerLike | null;
  addEventListener(type: 'updatefound', cb: () => void): void;
}
export interface ContainerLike {
  register(url: string): Promise<RegistrationLike>;
  addEventListener(type: 'controllerchange', cb: () => void): void;
  controller?: unknown;
}
export interface NavigatorLike {
  serviceWorker?: ContainerLike;
  storage?: { persist?: () => Promise<boolean> };
}

export interface SwOptions {
  emit(e: HostEvent): void;
  /** Default: `sw.js` next to the page. */
  url?: string;
  /** Default: the global `navigator`. */
  navigator?: NavigatorLike;
}

export interface SwHandle {
  /** Ask a waiting worker to take over. Resolves after it did (or after `timeoutMs`). Does not reload. */
  applyServiceWorkerUpdate(timeoutMs?: number): Promise<void>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Never throws. Emits `app:offline-ready` once a worker is active (the shell is fully cached and the next launch
 * works offline), `app:update-ready` when a newer worker is waiting, and `sw:unavailable` when there is none.
 */
export async function registerServiceWorker(o: SwOptions): Promise<SwHandle | undefined> {
  // Node 21+ has a global `navigator`; only a page (with a document) is a place to register a worker.
  const nav = o.navigator ?? (typeof document !== 'undefined' && typeof navigator !== 'undefined' ? (navigator as unknown as NavigatorLike) : undefined);
  if (!nav) return undefined; // not a browser
  const container = nav.serviceWorker;
  if (!container) {
    o.emit({ kind: 'sw:unavailable', reason: 'service workers are not supported here' });
    return undefined;
  }

  let reg: RegistrationLike;
  try {
    const url = o.url ?? (typeof document !== 'undefined' ? new URL('sw.js', document.baseURI).href : 'sw.js');
    reg = await container.register(url);
  } catch (e) {
    o.emit({ kind: 'sw:unavailable', reason: message(e) });
    return undefined;
  }

  let offlineReady = false;
  const ready = () => {
    if (offlineReady) return;
    offlineReady = true;
    o.emit({ kind: 'app:offline-ready' });
    // best effort: keep the local store from being evicted
    void Promise.resolve()
      .then(() => nav.storage?.persist?.())
      .catch(() => undefined);
  };
  let updateAnnounced = false;
  const update = () => {
    if (updateAnnounced) return;
    updateAnnounced = true;
    o.emit({ kind: 'app:update-ready' });
  };

  const track = (worker: WorkerLike) => {
    const check = () => {
      if (worker.state === 'activated') ready();
      // installed while another worker is active: this one waits for the app to ask
      else if (worker.state === 'installed' && reg.active && reg.active !== worker) update();
    };
    worker.addEventListener('statechange', check);
    check();
  };

  if (reg.active?.state === 'activated') ready();
  if (reg.waiting) update();
  if (reg.installing) track(reg.installing);
  reg.addEventListener('updatefound', () => {
    if (reg.installing) track(reg.installing);
  });

  return {
    applyServiceWorkerUpdate(timeoutMs = 3000) {
      const waiting = reg.waiting;
      if (!waiting) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        container.addEventListener('controllerchange', () => {
          clearTimeout(timer);
          resolve();
        });
        waiting.postMessage({ type: 'skipWaiting' });
      });
    },
  };
}
