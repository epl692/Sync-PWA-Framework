// T097 (Principle VII): core and transports work as plain static files on any static host, with no backend.
import { build } from 'esbuild';
import { createServer, type Server } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const outDir = join('test-results', 'static-sample');
let server: Server;
let port = 0;

test.beforeAll(async () => {
  mkdirSync(outDir, { recursive: true });
  await build({
    entryPoints: ['tests/e2e/entry.ts'],
    outfile: join(outDir, 'app.js'),
    bundle: true,
    format: 'esm',
    target: 'es2022',
    minify: true,
    conditions: ['browser'],
    tsconfig: 'tsconfig.json',
  });
  writeFileSync(join(outDir, 'index.html'), '<!doctype html><meta charset="utf-8"><title>static</title><script type="module" src="app.js"></script>');
  // The simplest possible static host: files only, no API, no websocket.
  server = createServer((req, res) => {
    const file = req.url === '/app.js' ? 'app.js' : 'index.html';
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html' });
    res.end(readFileSync(join(outDir, file)));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

test.afterAll(() => new Promise<void>((r) => server.close(() => r())));

test('a bundle served as static files runs fully offline-first', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => (window as any).__sync);
  const result = await page.evaluate(async () => {
    const { openCore } = (window as any).__sync;
    const core = await openCore('static-host');
    const o = await core.create('s1', 'note', { t: 'served as plain files' });
    return (await core.get(o.id)).fields.t;
  });
  expect(result).toBe('served as plain files');
});
