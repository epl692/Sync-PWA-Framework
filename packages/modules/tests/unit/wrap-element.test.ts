// @vitest-environment jsdom
// T029: element wrapper with an error boundary (FR-003, research R-05).
import { afterEach, describe, expect, it } from 'vitest';
import { wrapElement } from '../../src/ui/wrap-element';
import { fakeCtx, controlledQuery } from '../helpers';
import type { HostEvent } from '../../src/types';

let n = 0;
const errorsOnWindow: unknown[] = [];
const onErr = (e: ErrorEvent) => {
  errorsOnWindow.push(e.error ?? e.message);
  e.preventDefault();
};
window.addEventListener('error', onErr);
afterEach(() => {
  errorsOnWindow.length = 0;
  document.body.innerHTML = '';
});

function define(Base: CustomElementConstructor) {
  const events: HostEvent[] = [];
  const ctx = fakeCtx(controlledQuery().query);
  const name = `x-wrap-${++n}`;
  const Wrapped = wrapElement(Base, { ctx, module: 'todo', name, emit: (e) => events.push(e) });
  customElements.define(name, Wrapped);
  return { name, events, ctx, Wrapped };
}

describe('wrapElement', () => {
  it('guards connectedCallback: shows a placeholder, emits view:error, and nothing reaches the window', () => {
    const { name, events } = define(class extends HTMLElement {
      connectedCallback() {
        throw new Error('bad connect');
      }
    });
    const el = document.createElement(name);
    document.body.append(el);
    expect(errorsOnWindow).toEqual([]);
    expect(el.hasAttribute('data-module-error')).toBe(true);
    expect(el.textContent).toContain('todo');
    expect(el.textContent).toContain(name);
    expect(events).toEqual([{ kind: 'view:error', module: 'todo', element: name, error: 'bad connect' }]);
  });

  it('guards disconnectedCallback, attributeChangedCallback and adoptedCallback', () => {
    const { name, events } = define(class extends HTMLElement {
      static observedAttributes = ['v'];
      attributeChangedCallback() {
        throw new Error('attr');
      }
      disconnectedCallback() {
        throw new Error('disc');
      }
      adoptedCallback() {
        throw new Error('adopt');
      }
    });
    const el = document.createElement(name);
    document.body.append(el);
    el.setAttribute('v', '1');
    el.remove();
    document.adoptNode(el);
    expect(errorsOnWindow).toEqual([]);
    expect(events.map((e) => (e as { error: string }).error)).toEqual(expect.arrayContaining(['attr', 'disc']));
  });

  it('leaves healthy elements and other elements untouched', () => {
    const bad = define(class extends HTMLElement {
      connectedCallback() {
        throw new Error('x');
      }
    });
    const good = define(class extends HTMLElement {
      connectedCallback() {
        this.textContent = 'fine';
      }
    });
    document.body.append(document.createElement(bad.name), document.createElement(good.name));
    expect(document.querySelector(good.name)!.textContent).toBe('fine');
    expect(document.querySelector(good.name)!.hasAttribute('data-module-error')).toBe(false);
  });

  it('injects ctx on instances, available in the constructor', () => {
    let seenInCtor: unknown;
    const { name, ctx } = define(class extends HTMLElement {
      constructor() {
        super();
        seenInCtor = (this as unknown as { ctx: unknown }).ctx;
      }
    });
    const el = document.createElement(name) as HTMLElement & { ctx: unknown };
    expect(el.ctx).toBe(ctx);
    expect(seenInCtor).toBe(ctx);
  });

  it('routes errors from LiveElement-style render reporters to the same event', async () => {
    const { VIEW_ERROR } = await import('../../src/ui/live-element');
    const { name, events } = define(class extends HTMLElement {});
    const el = document.createElement(name) as HTMLElement & Record<symbol, (e: unknown) => void>;
    el[VIEW_ERROR]!(new Error('render failed'));
    expect(events).toEqual([{ kind: 'view:error', module: 'todo', element: name, error: 'render failed' }]);
    expect(el.hasAttribute('data-module-error')).toBe(true);
  });
});
