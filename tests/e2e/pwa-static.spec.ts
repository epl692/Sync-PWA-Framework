// T063 (US3, SC-001): the sample app served by a plain static file host is installable and works offline.
import { chromium, expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { buildApp } from '@sync/app-build';
import { staticHost } from './static-host';

const outDir = join('test-results', 'pwa-static');
const servers: Server[] = [];
test.beforeAll(async () => {
  await buildApp({ config: 'packages/sample-app/app.config.ts', outDir, exposeHost: true }); // the tests drive the host from the page
});
test.afterAll(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

async function installabilityErrors(page: Page): Promise<unknown[]> {
  const cdp = await page.context().newCDPSession(page);
  const { installabilityErrors } = (await cdp.send('Page.getInstallabilityErrors' as never)) as { installabilityErrors: unknown[] };
  return installabilityErrors;
}

for (const prefix of ['/', '/apps/sample/']) {
  test(`installable and offline-capable when served from ${prefix}`, async () => {
    const { server, origin } = await staticHost(outDir, prefix);
    servers.push(server);
    // A persistent profile: the default throw-away profile always reports "in-incognito", which says nothing about the app.
    const profile = mkdtempSync(join(tmpdir(), 'pwa-profile-'));
    const context = await chromium.launchPersistentContext(profile, { headless: true, executablePath: process.env.PW_CHROMIUM_PATH || undefined });
    const page = context.pages()[0] ?? (await context.newPage());
    const url = origin + prefix;
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await page.goto(url);
    await page.waitForFunction(() => (window as any).__syncHost);

    // modules are up, and the shell works with no server-side code
    const statuses = await page.evaluate(() => Object.fromEntries((window as any).__syncHost.report().map((r: any) => [r.id, r.status])));
    expect(statuses).toMatchObject({ identity: 'active', todo: 'active', stats: 'active' });

    // the worker finishes installing and the shell is fully cached
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          (window as any).__syncHost.on((e: { kind: string }) => e.kind === 'app:offline-ready' && resolve());
        }),
    );

    expect(await installabilityErrors(page)).toEqual([]);

    // write something, then lose the network and reload
    await page.locator('todo-list input').fill('Milk');
    await page.locator('todo-list button', { hasText: 'Add' }).click();
    await expect(page.locator('todo-list li')).toContainText('Milk');

    await context.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => (window as any).__syncHost);
    await expect(page.locator('todo-list li')).toContainText('Milk');
    const offlineStatuses = await page.evaluate(() => Object.fromEntries((window as any).__syncHost.report().map((r: any) => [r.id, r.status])));
    expect(offlineStatuses).toMatchObject({ identity: 'active', todo: 'active', stats: 'active' });

    expect(pageErrors).toEqual([]);
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  });
}
