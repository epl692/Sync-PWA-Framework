// @vitest-environment jsdom
// T033 (US1): two sample modules, bundled, activate in order and drive live views.
import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from '@sync/core';
import { memoryKeyDb, type Spaces } from '@sync/spaces';
import { createStubIdentityProvider, waitFor } from '@sync/testkit';
import { startApp } from '../../src/app/start-app';
import type { AppConfig } from '../../src/app/config';
import type { HostEvent, ModuleDefinition } from '../../src/types';
import stats from '../../../sample-app/modules/stats/index';
import todo from '../../../sample-app/modules/todo/index';

const prov: ModuleDefinition = { id: 'testprov', version: '1.0.0', provides: { identityProviders: [{ id: 'stub', create: () => createStubIdentityProvider() }] } };

async function boot(modules: ModuleDefinition[]) {
  let spaces!: Spaces;
  const events: HostEvent[] = [];
  const config: AppConfig = {
    name: 'T',
    themeColor: '#000000',
    icons: { src192: 'a', src512: 'b' },
    modules,
    runtime: { manifest: false },
    async onReady(_h, s) {
      spaces = s;
      await s.signUp('Me');
      await s.create('Personal');
    },
  };
  const host = await startApp(config, { storage: createMemoryStorage(), keyDb: memoryKeyDb(), mode: 'development' });
  host.on((e) => events.push(e));
  const space = (await spaces.list())[0]!.id;
  return { host, space, events };
}

const text = (el: Element) => el.shadowRoot!.textContent ?? '';

describe('bundled sample modules', () => {
  it('activate in dependency order and render live views', async () => {
    const order: string[] = [];
    const watch: ModuleDefinition = { id: 'watcher', version: '1.0.0', dependencies: { stats: '^1.0.0' }, activate: () => void order.push('watcher') };
    const { host, space } = await boot([
      watch,
      { ...stats, activate: () => void order.push('stats') },
      { ...todo, activate: () => void order.push('todo') },
      prov,
    ]);
    expect(order).toEqual(['todo', 'stats', 'watcher']);
    const status = Object.fromEntries(host.report().map((r) => [r.id, r.status]));
    expect(status).toMatchObject({ todo: 'active', stats: 'active', watcher: 'active', testprov: 'active' });

    const list = document.createElement('todo-list');
    const summary = document.createElement('stats-summary');
    document.body.append(list, summary);
    await waitFor(() => text(summary) === '0 open, 0 done');

    const a = await host.core.create(space, 'todo.item', { title: 'Milk' }, { schemaVersion: 1 });
    await host.core.create(space, 'todo.item', { title: 'Eggs' }, { schemaVersion: 1 });
    await waitFor(() => text(list).includes('Milk') && text(list).includes('Eggs'));
    await waitFor(() => text(summary) === '2 open, 0 done');
    expect(document.documentElement.dataset.openCount).toBe('2'); // the feature ran without a view

    await host.core.update(a.id, { done: true });
    await waitFor(() => text(summary) === '1 open, 1 done');
    await host.core.update(a.id, { title: 'Oat milk' });
    await waitFor(() => text(list).includes('Oat milk'));
    expect(text(list)).not.toMatch(/(^|[^t] )Milk/);
    await host.core.remove(a.id);
    await waitFor(() => text(summary) === '1 open, 0 done');

    list.remove();
    summary.remove();
    await host.stop();
  });

  it('a colliding module fails alone and the others keep working', async () => {
    const one: ModuleDefinition = { id: 'dupe', version: '1.0.0' };
    const two: ModuleDefinition = { id: 'dupe', version: '1.1.0' };
    const fine: ModuleDefinition = { id: 'fine', version: '1.0.0', provides: { types: [{ name: 'thing', versions: [{ version: 1, fields: { a: { type: 'string' } } }] }] } };
    const { host, space } = await boot([prov, one, two, fine]);
    const reports = host.report();
    const dupes = reports.filter((r) => r.id === 'dupe');
    expect(dupes.map((r) => r.status).sort()).toEqual(['active', 'failed']);
    expect(dupes.find((r) => r.status === 'failed')!.reason).toMatch(/duplicate module id "dupe".*1\.0\.0.*1\.1\.0/);
    expect(reports.find((r) => r.id === 'fine')!.status).toBe('active');
    expect((await host.core.create(space, 'fine.thing', { a: 'x' })).fields).toEqual({ a: 'x' });
    await host.stop();
  });
});
