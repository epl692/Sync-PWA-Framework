// T106 (SC-005): a crashing module leaves every other module functional.
import { chromium, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '@sync/app-build';
import { staticHost } from './static-host';

const root = resolve('test-results', 'crash-app');
const out = join(root, 'dist');
const sample = resolve('packages/sample-app');

function writeApp() {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'crash.ts'),
    `import type { ModuleDefinition } from '@sync/modules';
// one module that throws while activating
export const boomact = { id: 'boomact', version: '1.0.0', activate() { throw new Error('boom at activation'); } } satisfies ModuleDefinition;
// one whose view throws as soon as it is on the page
export const boomview = {
  id: 'boomview', version: '1.0.0',
  provides: { views: { x: () => class extends HTMLElement { connectedCallback() { throw new Error('view exploded'); } } } },
} satisfies ModuleDefinition;
// one whose feature handler throws every time
export const boomfeat = {
  id: 'boomfeat', version: '1.0.0',
  access: { types: { read: ['todo.item'] }, spaces: { read: 'any' } },
  provides: { features: [{ id: 'f', singleton: false, start: (ctx) => { ctx.data.query({ type: 'todo.item' }).subscribe(() => { throw new Error('feature handler failed'); }); } }] },
} satisfies ModuleDefinition;
// and one that behaves
export const calm = { id: 'calm', version: '1.0.0', provides: { types: [{ name: 'thing', versions: [{ version: 1, fields: { a: { type: 'string' } } }] }] } } satisfies ModuleDefinition;
`,
  );
  writeFileSync(
    join(root, 'app.config.ts'),
    `import type { AppConfig } from '@sync/modules';
import identity from '${sample}/infra/identity/index';
import todo from '${sample}/modules/todo/index';
import { boomact, boomview, boomfeat, calm } from './crash';

export default {
  name: 'Crash',
  themeColor: '#aa0000',
  icons: { src192: '${sample}/public/icons/icon-192.png', src512: '${sample}/public/icons/icon-512.png' },
  modules: [identity, boomact, boomview, todo, boomfeat, calm],
  identityProvider: 'identity.invite',
  async onReady(host, spaces) {
    if (!spaces.session()) await spaces.signUp('Me');
    const space = (await spaces.list())[0] ?? (await spaces.create('Personal'));
    await host.bindSpace('todo', space.id, 'rw');
  },
} satisfies AppConfig;
`,
  );
  writeFileSync(
    join(root, 'index.template.html'),
    '<!doctype html><html><head><meta charset="utf-8"><title>Crash</title></head><body><div id="app"><boomview-x></boomview-x><todo-list></todo-list></div></body></html>',
  );
}

test('crashing modules leave the rest of the app working', async () => {
  writeApp();
  await buildApp({ config: join(root, 'app.config.ts'), outDir: out, exposeHost: true });
  const { server, origin } = await staticHost(out, '/');
  const profile = mkdtempSync(join(tmpdir(), 'crash-profile-'));
  const context = await chromium.launchPersistentContext(profile, { headless: true, executablePath: process.env.PW_CHROMIUM_PATH || undefined });
  const page = context.pages()[0] ?? (await context.newPage());
  const logs: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => pageErrors.push(e.message));

  try {
    await page.goto(origin + '/');
    await page.waitForFunction(() => (window as any).__syncHost);
    await page.evaluate(() => (window as any).__syncHost.ready());

    // the failure is reported with its reason, and only that module failed
    const report = await page.evaluate(() => Object.fromEntries((window as any).__syncHost.report().map((r: any) => [r.id, { status: r.status, reason: r.reason }])));
    expect(report.boomact).toMatchObject({ status: 'failed', reason: expect.stringContaining('boom at activation') });
    expect(report).toMatchObject({ identity: { status: 'active' }, todo: { status: 'active' }, boomview: { status: 'active' }, boomfeat: { status: 'active' }, calm: { status: 'active' } });

    // the broken view shows a placeholder where it sits, and nothing else is touched
    const broken = page.locator('boomview-x');
    await expect(broken).toHaveAttribute('data-module-error', '');
    await expect(broken).toContainText('boomview');
    expect(logs.join('\n')).toContain('view <boomview-x> of module "boomview" failed: view exploded');

    // the healthy module keeps working, through five failures of the other module's feature
    for (const title of ['one', 'two', 'three', 'four', 'five']) {
      await page.locator('todo-list input[placeholder]').fill(title);
      await page.locator('todo-list button', { hasText: 'Add' }).click();
      await expect(page.locator('todo-list li', { hasText: title })).toBeVisible();
    }
    await expect.poll(() => logs.join('\n')).toContain('feature "boomfeat.f" stopped: feature handler failed');
    await expect(page.locator('todo-list li')).toHaveCount(5);

    // nothing escaped to the page
    expect(pageErrors).toEqual([]);
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
    server.close();
  }
});
