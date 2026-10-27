// T030: features run logic without a view (FR-008): subscriptions, singleton locks, failure limit.
import { describe, expect, it } from 'vitest';
import { FeatureRunner } from '../../src/features/runner';
import type { FeatureDef, HostEvent, ProjectedObject } from '../../src/types';
import { controlledQuery, fakeCtx, fakeLocks, row, tick } from '../helpers';

function setup(opts: { locks?: ReturnType<typeof fakeLocks> | null } = {}) {
  const cq = controlledQuery();
  const events: HostEvent[] = [];
  const warnings: string[] = [];
  const ctx = fakeCtx(cq.query, { moduleId: 'stats', log: { info() {}, error() {}, warn: (m: string) => void warnings.push(m) } });
  const runner = new FeatureRunner({ emit: (e) => events.push(e), locks: opts.locks === undefined ? null : opts.locks, maxFailures: 5 });
  return { cq, events, warnings, ctx, runner };
}

describe('FeatureRunner', () => {
  it('lets a feature react to object changes with no view', async () => {
    const { cq, ctx, runner } = setup();
    const seen: number[] = [];
    const def: FeatureDef = { id: 'count', singleton: false, start: (c) => void c.data.query({ type: 'todo.item' }).subscribe((rows: ProjectedObject[]) => void seen.push(rows.length)) };
    await runner.start('stats', def, ctx);
    cq.emit([row('a'), row('b')]);
    expect(seen).toEqual([0, 2]);
  });

  it('stop() unsubscribes everything the feature subscribed, calls the returned cleanup and def.stop', async () => {
    const { cq, ctx, runner } = setup();
    const log: string[] = [];
    const def: FeatureDef = {
      id: 'f',
      singleton: false,
      start: (c) => {
        c.data.query({ type: 't' }).subscribe(() => {});
        return () => void log.push('cleanup');
      },
      stop: () => void log.push('stop'),
    };
    const h = await runner.start('stats', def, ctx);
    expect(cq.active).toBe(1);
    await h.stop();
    expect(cq.active).toBe(0);
    expect(log).toEqual(['cleanup', 'stop']);
  });

  it('stops after five consecutive handler failures and emits feature:stopped', async () => {
    const { cq, ctx, runner, events } = setup();
    let calls = 0;
    const def: FeatureDef = {
      id: 'bad',
      singleton: false,
      start: (c) => void c.data.query({ type: 't' }).subscribe(() => {
        calls++;
        throw new Error(`fail ${calls}`);
      }),
    };
    const h = await runner.start('stats', def, ctx); // initial emission = failure 1
    for (let i = 0; i < 6; i++) cq.emit([row(`r${i}`)]);
    expect(calls).toBe(5);
    expect(h.state).toBe('stopped');
    expect(cq.active).toBe(0);
    expect(events).toEqual([{ kind: 'feature:stopped', module: 'stats', feature: 'bad', error: 'fail 5' }]);
  });

  it('a success resets the failure count', async () => {
    const { cq, ctx, runner, events } = setup();
    let calls = 0;
    const def: FeatureDef = {
      id: 'flaky',
      singleton: false,
      start: (c) => void c.data.query({ type: 't' }).subscribe(() => {
        if (++calls % 3 !== 0) throw new Error('x');
      }),
    };
    const h = await runner.start('stats', def, ctx);
    for (let i = 0; i < 30; i++) cq.emit([row(`r${i}`)]);
    expect(h.state).toBe('running');
    expect(events).toEqual([]);
  });

  it('a start() that throws stops the feature and reports it', async () => {
    const { ctx, runner, events } = setup();
    const def: FeatureDef = { id: 'dead', singleton: false, start: () => { throw new Error('no start'); } };
    const h = await runner.start('stats', def, ctx);
    expect(h.state).toBe('stopped');
    expect(events).toEqual([{ kind: 'feature:stopped', module: 'stats', feature: 'dead', error: 'no start' }]);
  });

  it('a singleton feature runs in one runner at a time (Web Locks), the next takes over on stop', async () => {
    const locks = fakeLocks();
    const a = setup({ locks });
    const b = setup({ locks });
    const started: string[] = [];
    const def = (tag: string): FeatureDef => ({ id: 'remind', start: () => void started.push(tag) });
    const ha = await a.runner.start('stats', def('A'), a.ctx);
    const hb = await b.runner.start('stats', def('B'), b.ctx);
    await tick();
    expect(locks.requested).toEqual(['sync-feature:stats.remind', 'sync-feature:stats.remind']);
    expect(started).toEqual(['A']);
    expect(ha.state).toBe('running');
    expect(hb.state).toBe('waiting');
    await ha.stop();
    await tick();
    expect(started).toEqual(['A', 'B']);
    expect(hb.state).toBe('running');
    await hb.stop();
  });

  it('without Web Locks a singleton feature still runs, with a warning', async () => {
    const { ctx, runner, warnings } = setup({ locks: null });
    const started: number[] = [];
    const h = await runner.start('stats', { id: 'remind', start: () => void started.push(1) }, ctx);
    expect(started).toEqual([1]);
    expect(h.state).toBe('running');
    expect(warnings.join()).toMatch(/Web Locks/);
  });
});
