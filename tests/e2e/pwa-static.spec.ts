// T063 (US3, SC-001): the sample app served by a plain static file host is installable and works offline.
import { chromium, expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { buildApp } from '@sync/app-build';

const outDir = join('test-results', 'pwa-static');
const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

/** The simplest possible static host: files under a URL prefix, nothing else. No rewrites, no API, no special headers. */
function staticHost(prefix: string): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
      if (!path.startsWith(prefix)) return void res.writeHead(404).end();
      let rel = normalize('/' + path.slice(prefix.length)).slice(1); // no way out of the folder
      if (rel === '' || rel.endsWith('/')) rel += 'index.html';
      const file = join(outDir, rel);
      if (!existsSync(file) || !statSync(file).isFile()) return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://localhost:${(server.address() as { port: number }).port}` }));
  });
}

const servers: Server[] = [];
test.beforeAll(async () => {
  await buildApp({ config: 'packages/sample-app/app.config.ts', outDir });
});
test.afterAll(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

async function installabilityErrors(page: Page): Promise<unknown[]> {
  const cdp = await page.context().newCDPSession(page);
  const { installabilityErrors } = (await cdp.send('Page.getInstallabilityErrors' as never)) as { installabilityErrors: unknown[] };
  return installabilityErrors;
}

for (const prefix of ['/', '/apps/sample/']) {
  test(`installable and offline-capable when served from ${prefix}`, async () => {
    const { server, origin } = await staticHost(prefix);
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
