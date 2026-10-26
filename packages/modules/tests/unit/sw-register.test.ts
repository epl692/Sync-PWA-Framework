// T062: service worker registration and lifecycle events.
import { describe, expect, it, vi } from 'vitest';
import { registerServiceWorker, type ContainerLike, type NavigatorLike, type RegistrationLike, type WorkerLike } from '../../src/app/sw-register';
import type { HostEvent } from '../../src/types';
import { tick } from '../helpers';

class FakeWorker implements WorkerLike {
  private cbs: Array<() => void> = [];
  postMessage = vi.fn();
  constructor(public state: string) {}
  addEventListener(_t: 'statechange', cb: () => void) {
    this.cbs.push(cb);
  }
  set(state: string) {
    this.state = state;
    this.cbs.forEach((c) => c());
  }
}

class FakeReg implements RegistrationLike {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  active: FakeWorker | null = null;
  private found: Array<() => void> = [];
  addEventListener(_t: 'updatefound', cb: () => void) {
    this.found.push(cb);
  }
  updateFound(w: FakeWorker) {
    this.installing = w;
    this.found.forEach((c) => c());
  }
}

function setup(reg = new FakeReg(), opts: { persist?: () => Promise<boolean>; registerError?: Error } = {}) {
  const events: HostEvent[] = [];
  const controllerChange: Array<() => void> = [];
  const container: ContainerLike = {
    register: async () => {
      if (opts.registerError) throw opts.registerError;
      return reg;
    },
    addEventListener: (_t, cb) => void controllerChange.push(cb),
  };
  const nav: NavigatorLike = { serviceWorker: container, storage: opts.persist ? { persist: opts.persist } : undefined };
  const handle = registerServiceWorker({ emit: (e) => void events.push(e), navigator: nav, url: 'sw.js' });
  return { reg, events, handle, controllerChange };
}

describe('registerServiceWorker', () => {
  it('first install: emits app:offline-ready once the worker activates, and asks for persistent storage', async () => {
    const persist = vi.fn(async () => true);
    const reg = new FakeReg();
    const w = new FakeWorker('installing');
    reg.installing = w;
    const { events, handle } = setup(reg, { persist });
    await handle;
    expect(events).toEqual([]);
    w.set('installed');
    w.set('activating');
    expect(events).toEqual([]);
    w.set('activated');
    w.set('activated');
    await tick();
    expect(events).toEqual([{ kind: 'app:offline-ready' }]);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('a returning visit with an active worker is offline-ready straight away', async () => {
    const reg = new FakeReg();
    reg.active = new FakeWorker('activated');
    const { events, handle } = setup(reg);
    await handle;
    expect(events).toEqual([{ kind: 'app:offline-ready' }]);
  });

  it('a newer worker that finishes installing while another is active emits app:update-ready, once', async () => {
    const reg = new FakeReg();
    reg.active = new FakeWorker('activated');
    const { events, handle } = setup(reg);
    await handle;
    events.length = 0;
    const next = new FakeWorker('installing');
    reg.updateFound(next);
    next.set('installed');
    reg.waiting = next;
    next.set('installed');
    expect(events).toEqual([{ kind: 'app:update-ready' }]);
  });

  it('a worker already waiting at registration emits app:update-ready', async () => {
    const reg = new FakeReg();
    reg.active = new FakeWorker('activated');
    reg.waiting = new FakeWorker('installed');
    const { events, handle } = setup(reg);
    await handle;
    expect(events.map((e) => e.kind)).toEqual(['app:offline-ready', 'app:update-ready']);
  });

  it('applyServiceWorkerUpdate posts skipWaiting to the waiting worker and resolves on controllerchange, without reloading', async () => {
    const reg = new FakeReg();
    reg.active = new FakeWorker('activated');
    reg.waiting = new FakeWorker('installed');
    const { handle, controllerChange } = setup(reg);
    const h = (await handle)!;
    const done = h.applyServiceWorkerUpdate(5000);
    expect(reg.waiting.postMessage).toHaveBeenCalledWith({ type: 'skipWaiting' });
    controllerChange.forEach((c) => c());
    await done;
  });

  it('applyServiceWorkerUpdate with nothing waiting resolves at once', async () => {
    const reg = new FakeReg();
    reg.active = new FakeWorker('activated');
    const h = (await setup(reg).handle)!;
    await h.applyServiceWorkerUpdate();
  });

  it('emits sw:unavailable when registration fails, and when service workers are unsupported', async () => {
    const failed = setup(new FakeReg(), { registerError: new Error('SecurityError: nope') });
    expect(await failed.handle).toBeUndefined();
    expect(failed.events).toEqual([{ kind: 'sw:unavailable', reason: 'SecurityError: nope' }]);

    const events: HostEvent[] = [];
    expect(await registerServiceWorker({ emit: (e) => void events.push(e), navigator: {} })).toBeUndefined();
    expect(events).toEqual([{ kind: 'sw:unavailable', reason: expect.stringContaining('not supported') }]);
  });

  it('a throwing or missing storage.persist never breaks it', async () => {
    const reg = new FakeReg();
    reg.active = new FakeWorker('activated');
    const { events, handle } = setup(reg, { persist: async () => { throw new Error('denied'); } });
    await handle;
    await tick();
    expect(events).toEqual([{ kind: 'app:offline-ready' }]);
  });

  it('does nothing outside a browser', async () => {
    const events: HostEvent[] = [];
    expect(await registerServiceWorker({ emit: (e) => void events.push(e) })).toBeUndefined();
    expect(events).toEqual([]);
  });
});
