/** Optional base class for views: binds the element to reactive queries for as long as it is connected (FR-007). */

import type { FacadeQuerySpec, LiveElementInstance, ModuleContext, ProjectedObject } from '../types';
import { VIEW_ERROR } from './symbols';

export { VIEW_ERROR };

// Importable in Node (no DOM): the class is only usable where HTMLElement exists.
const Base = (globalThis.HTMLElement ?? class {}) as typeof HTMLElement;

interface Binding {
  spec: FacadeQuerySpec;
  render: (rows: ProjectedObject[]) => void;
  unsub?: () => void;
  latest: ProjectedObject[];
  scheduled: boolean;
  active: boolean;
}

const nextFrame = (cb: () => void) => (globalThis.requestAnimationFrame ? void globalThis.requestAnimationFrame(() => cb()) : queueMicrotask(cb));

export class LiveElement extends Base implements LiveElementInstance {
  /** Injected by the host wrapper as a prototype getter. */
  declare readonly ctx: ModuleContext;

  readonly #bindings: Binding[] = [];

  /**
   * Render `spec`'s results whenever they change, at most once per animation frame.
   * Subscribes now if the element is connected, otherwise on connect.
   */
  bind(spec: FacadeQuerySpec, render: (rows: ProjectedObject[]) => void): void {
    const b: Binding = { spec, render, latest: [], scheduled: false, active: false };
    this.#bindings.push(b);
    if (this.isConnected) this.#start(b);
  }

  /** Subclasses that override this MUST call `super.connectedCallback()`. */
  connectedCallback(): void {
    for (const b of this.#bindings) this.#start(b);
  }

  /** Subclasses that override this MUST call `super.disconnectedCallback()`. */
  disconnectedCallback(): void {
    for (const b of this.#bindings) this.#stop(b);
  }

  #start(b: Binding): void {
    if (b.active) return;
    b.active = true;
    b.unsub = this.ctx.data.query(b.spec).subscribe((rows) => {
      b.latest = rows;
      this.#schedule(b);
    });
  }

  #stop(b: Binding): void {
    b.active = false;
    b.unsub?.();
    b.unsub = undefined;
  }

  #schedule(b: Binding): void {
    if (b.scheduled || !b.active) return;
    b.scheduled = true;
    nextFrame(() => {
      b.scheduled = false;
      if (!b.active) return;
      try {
        b.render(b.latest);
      } catch (e) {
        this.#report(e);
      }
    });
  }

  #report(e: unknown): void {
    const report = (this as unknown as Record<symbol, ((e: unknown) => void) | undefined>)[VIEW_ERROR];
    if (typeof report === 'function') report.call(this, e);
    else console.error(e);
  }
}
