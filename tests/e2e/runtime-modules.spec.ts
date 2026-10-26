// T077 (US4, quickstart S4): modules added at runtime are cached, same-origin only, and never take the app down.
import { chromium, expect, test, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, buildModule } from '@sync/app-build';
import { staticHost } from './static-host';

const dir = join('test-results', 'runtime-modules');

/** A runtime module whose view prints its version, built exactly as a module author would. */
async function buildNotes(version: string, label = version) {
  const work = mkdtempSync(join(tmpdir(), 'notes-src-'));
  const entry = join(work, 'index.ts');
  writeFileSync(
    entry,
    `export default { id: 'notes', version: '${version}', provides: { views: { list: () => class extends HTMLElement { connectedCallback() { this.textContent = 'notes ${label}'; } } } } };`,
  );
  const out = join(dir, 'modules', `notes.${version}.js`);
  const built = await buildModule({ entry, outFile: out });
  rmSync(work, { recursive: true, force: true });
  return built;
}

const manifestPath = join(dir, 'modules', 'manifest.json');
const readManifest = () => JSON.parse(readFileSync(manifestPath, 'utf8')) as { v: number; modules: Array<Record<string, unknown>> };
const writeManifest = (modules: unknown[]) => writeFileSync(manifestPath, JSON.stringify({ v: 1, modules }));

const statuses = (page: Page) =>
  page.evaluate(() => Object.fromEntries((window as any).__syncHost.report().map((r: any) => [r.id, { status: r.status, version: r.version }])));
const ready = async (page: Page) => {
  await page.waitForFunction(() => (window as any).__syncHost);
  await page.evaluate(() => (window as any).__syncHost.ready());
};

test('runtime modules: first load, offline, refusals, stale copy, integrity, updates', async () => {
  await buildApp({ config: 'packages/sample-app/app.config.ts', outDir: dir, exposeHost: true }); // the tests drive the host from the page
  const { server, origin } = await staticHost(dir, '/');
  const evilRequests: string[] = [];
  const evil = await staticHost(dir, '/', (p) => evilRequests.push(p));
  const profile = mkdtempSync(join(tmpdir(), 'rt-profile-'));
  const context = await chromium.launchPersistentContext(profile, { headless: true, executablePath: process.env.PW_CHROMIUM_PATH || undefined });
  const page = context.pages()[0] ?? (await context.newPage());
  const logs: string[] = [];
  page.on('console', (m) => logs.push(m.text()));
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  try {
    // 1. first online start: the module loads, registers, and is cached
    await page.goto(`${origin}/#notes`);
    await ready(page);
    expect(await statuses(page)).toMatchObject({ notes: { status: 'active', version: '1.0.0' } });
    await page.locator('notes-list input').fill('hello');
    await page.locator('notes-list button', { hasText: 'Add note' }).click();
    await expect(page.locator('notes-list li')).toContainText('hello');
    await page.evaluate(() => new Promise<void>((resolve) => (window as any).__syncHost.on((e: any) => e.kind === 'app:offline-ready' && resolve())));

    // 2. offline: the manifest and the module come from the loader's cache, and the data is local
    await context.setOffline(true);
    await page.goto(`${origin}/#notes`);
    await page.reload();
    await ready(page);
    expect(await statuses(page)).toMatchObject({ notes: { status: 'active', version: '1.0.0' } });
    await expect(page.locator('notes-list li')).toContainText('hello');
    await context.setOffline(false);

    // 3. an entry on another origin is refused and logged, and its file is never requested
    const baseManifest = readManifest().modules;
    writeManifest([...baseManifest, { id: 'evil', version: '1.0.0', url: `${evil.origin}/modules/notes.1.0.0.js` }]);
    logs.length = 0;
    await page.reload();
    await ready(page);
    expect(logs.join('\n')).toMatch(/evil refused \(cross-origin\)/);
    expect(evilRequests).toEqual([]);
    expect(await statuses(page)).toMatchObject({ notes: { status: 'active' }, todo: { status: 'active' } });
    expect(await statuses(page)).not.toHaveProperty('evil');

    // 4. the manifest asks for 1.1.0 but its file cannot be reached: the cached 1.0.0 keeps running (stale)
    const v110 = await buildNotes('1.1.0');
    rmSync(join(dir, 'modules', 'notes.1.1.0.js'));
    writeManifest([{ id: 'notes', version: '1.1.0', url: 'notes.1.1.0.js', integrity: v110.integrity }]);
    logs.length = 0;
    await page.reload();
    await ready(page);
    expect(await statuses(page)).toMatchObject({ notes: { status: 'stale', version: '1.0.0' } });
    expect(logs.join('\n')).toMatch(/running from its cached copy 1\.0\.0/);

    // 5. a file that does not match its hash is refused, and the old copy keeps running
    await buildNotes('1.1.0', 'tampered');
    logs.length = 0;
    await page.reload();
    await ready(page);
    expect(await statuses(page)).toMatchObject({ notes: { status: 'stale', version: '1.0.0' } });
    expect(logs.join('\n')).toMatch(/refused \(integrity\)/);

    // 6. a good 1.1.0 appears while the app is open: announced, cached, and nothing running changes
    await page.evaluate(() => {
      (window as any).__events = [];
      (window as any).__syncHost.on((e: any) => (window as any).__events.push(e));
    });
    await buildNotes('1.1.0'); // matches the manifest's hash again
    await page.evaluate(() => (window as any).__syncHost.checkForUpdates());
    expect(await page.evaluate(() => (window as any).__events)).toContainEqual({ kind: 'module:update-available', id: 'notes', version: '1.1.0' });
    expect(await statuses(page)).toMatchObject({ notes: { version: '1.0.0' } });

    // ...and the next launch uses it, even offline
    await context.setOffline(true);
    await page.reload();
    await ready(page);
    expect(await statuses(page)).toMatchObject({ notes: { status: 'active', version: '1.1.0' } });
    await page.evaluate(() => (location.hash = '#notes'));
    await expect(page.locator('notes-list')).toContainText('notes 1.1.0');

    expect(pageErrors).toEqual([]);
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
    server.close();
    evil.server.close();
  }
});
