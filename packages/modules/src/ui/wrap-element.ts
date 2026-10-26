/** Defines views behind an error boundary: a throwing lifecycle callback cannot break the page (FR-003, R-05). */

import type { HostEvent, ModuleContext } from '../types';
import { VIEW_ERROR } from './symbols';

const LIFECYCLE = ['connectedCallback', 'disconnectedCallback', 'attributeChangedCallback', 'adoptedCallback'] as const;

export interface WrapOptions {
  ctx: ModuleContext;
  module: string;
  /** Full element name, `<moduleId>-<name>`. */
  name: string;
  emit(e: HostEvent): void;
}

/**
 * A subclass of the module's element class whose lifecycle callbacks are guarded and that carries `ctx` as a
 * prototype getter. Errors thrown by the element's own constructor cannot be contained here (the browser reports them).
 */
export function wrapElement(Base: CustomElementConstructor, o: WrapOptions): CustomElementConstructor {
  const fail = (el: HTMLElement, err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err);
    o.emit({ kind: 'view:error', module: o.module, element: o.name, error: message });
    try {
      const root: ParentNode = el.shadowRoot ?? el;
      root.replaceChildren();
      const note = el.ownerDocument.createElement('span');
      note.setAttribute('role', 'alert');
      note.textContent = `module "${o.module}": view <${o.name}> failed`;
      root.append(note);
      el.setAttribute('data-module-error', '');
    } catch {
      /* nothing more can be done for this element */
    }
  };

  const Wrapped = class extends (Base as unknown as new () => HTMLElement) {} as unknown as CustomElementConstructor;
  const proto = Wrapped.prototype as unknown as Record<string | symbol, unknown>;
  for (const cb of LIFECYCLE) {
    const original = (Base.prototype as Record<string, unknown>)[cb];
    if (typeof original !== 'function') continue;
    Object.defineProperty(proto, cb, {
      configurable: true,
      writable: true,
      value(this: HTMLElement, ...args: unknown[]) {
        try {
          return (original as (...a: unknown[]) => unknown).apply(this, args);
        } catch (e) {
          fail(this, e);
          return undefined;
        }
      },
    });
  }
  Object.defineProperty(proto, 'ctx', { configurable: true, get: () => o.ctx });
  Object.defineProperty(proto, VIEW_ERROR, {
    configurable: true,
    value(this: HTMLElement, err: unknown) {
      fail(this, err);
    },
  });
  return Wrapped;
}
