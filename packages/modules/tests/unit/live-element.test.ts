// @vitest-environment jsdom
// T028: LiveElement binds views to reactive queries (FR-007).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LiveElement, VIEW_ERROR } from '../../src/ui/live-element';
import { controlledQuery, fakeCtx, manualFrames, row } from '../helpers';
import type { ProjectedObject } from '../../src/types';

let frames: ReturnType<typeof manualFrames>;
let n = 0;
beforeEach(() => void (frames = manualFrames()));
afterEach(() => frames.restore());

function setup(render: (rows: ProjectedObject[]) => void, opts: { bindInCtor?: boolean } = {}) {
  const cq = controlledQuery();
  const ctx = fakeCtx(cq.query);
  const name = `x-live-${++n}`;
  class V extends LiveElement {
    constructor() {
      super();
      if (opts.bindInCtor !== false) this.bind({ type: 'fake.t' }, render);
    }
  }
  Object.defineProperty(V.prototype, 'ctx', { get: () => ctx });
  customElements.define(name, V);
  return { cq, ctx, name, V };
}

describe('LiveElement', () => {
  it('subscribes on connect and unsubscribes on disconnect', () => {
    const { cq, name } = setup(() => {});
    const el = document.createElement(name);
    expect(cq.stats.subscribed).toBe(0);
    document.body.append(el);
    expect(cq.stats.subscribed).toBe(1);
    el.remove();
    expect(cq.stats.unsubscribed).toBe(1);
    expect(cq.active).toBe(0);
    document.body.append(el);
    expect(cq.stats.subscribed).toBe(2);
    el.remove();
  });

  it('coalesces emissions into one render per animation frame, with the latest rows', () => {
    const seen: string[][] = [];
    const { cq, name } = setup((rows) => seen.push(rows.map((r) => r.id)));
    const el = document.createElement(name);
    document.body.append(el); // initial emission (empty)
    cq.emit([row('a')]);
    cq.emit([row('a'), row('b')]);
    cq.emit([row('c')]);
    expect(seen).toEqual([]);
    expect(frames.flush()).toBe(1);
    expect(seen).toEqual([['c']]);
    cq.emit([row('d')]);
    expect(frames.flush()).toBe(1);
    expect(seen).toEqual([['c'], ['d']]);
    el.remove();
  });

  it('does not render after disconnect, even if a frame was already scheduled', () => {
    const seen: number[] = [];
    const { cq, name } = setup((rows) => seen.push(rows.length));
    const el = document.createElement(name);
    document.body.append(el);
    cq.emit([row('a')]);
    el.remove();
    frames.flush();
    expect(seen).toEqual([]);
  });

  it('contains an exception in render, reports it, and keeps rendering later updates', () => {
    const errors: unknown[] = [];
    let calls = 0;
    const { cq, name, V } = setup(() => {
      if (++calls === 1) throw new Error('boom');
    });
    (V.prototype as unknown as Record<symbol, unknown>)[VIEW_ERROR] = (e: unknown) => errors.push(e);
    const el = document.createElement(name);
    document.body.append(el);
    frames.flush();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('boom');
    cq.emit([row('a')]);
    frames.flush();
    expect(calls).toBe(3 - 1); // first (threw) + second
    el.remove();
  });

  it('bind() on a connected element subscribes immediately', () => {
    const { cq, name } = setup(() => {}, { bindInCtor: false });
    const el = document.createElement(name) as LiveElement;
    document.body.append(el);
    expect(cq.stats.subscribed).toBe(0);
    el.bind({ type: 'fake.t' }, () => {});
    expect(cq.stats.subscribed).toBe(1);
    el.remove();
  });

  it('passes the query spec to ctx.data.query', () => {
    const { ctx, name } = setup(() => {});
    const el = document.createElement(name);
    document.body.append(el);
    expect((ctx as unknown as { calls: unknown[] }).calls).toEqual([{ type: 'fake.t' }]);
    el.remove();
  });
});
