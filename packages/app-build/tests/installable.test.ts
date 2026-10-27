// T061: verifyInstallable reports each missing piece.
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex, verifyInstallable } from '../src/installable';
import { generateServiceWorker } from '../src/sw-template';
import { cleanup, png, tmpDir, write } from './helpers';

afterAll(cleanup);

const manifest = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: 'App',
    start_url: './',
    scope: './',
    display: 'standalone',
    icons: [
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    ...over,
  });

/** A good build; `tweak` can break one thing. */
function build(tweak: (dir: string) => void = () => {}): string {
  const dir = tmpDir('b');
  write(dir, 'index.html', '<html><head><link rel="manifest" href="manifest.webmanifest"></head><body></body></html>');
  write(dir, 'manifest.webmanifest', manifest());
  write(dir, 'icons/icon-192.png', png(192));
  write(dir, 'icons/icon-512.png', png(512));
  write(dir, 'app.1.js', 'navigator.serviceWorker.register(new URL("sw.js", document.baseURI));');
  const files = ['index.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'app.1.js'].map((url) => ({ url, revision: sha256Hex(readFileSync(join(dir, url))) }));
  write(dir, 'sw.js', generateServiceWorker({ build: 'x', files }));
  tweak(dir);
  return dir;
}

describe('verifyInstallable', () => {
  it('passes a good build', async () => {
    expect(await verifyInstallable(build())).toEqual({ ok: true, problems: [] });
  });

  it.each<[string, (d: string) => void, RegExp]>([
    ['no name', (d) => write(d, 'manifest.webmanifest', manifest({ name: undefined, short_name: undefined })), /neither name nor short_name/],
    ['no start_url', (d) => write(d, 'manifest.webmanifest', manifest({ start_url: undefined })), /no start_url/],
    ['start_url outside the app', (d) => write(d, 'manifest.webmanifest', manifest({ start_url: '../x' })), /start_url.*outside the app/],
    ['absolute scope', (d) => write(d, 'manifest.webmanifest', manifest({ scope: '/' })), /scope.*outside the app/],
    ['browser display', (d) => write(d, 'manifest.webmanifest', manifest({ display: 'browser' })), /display/],
    ['no 192 icon', (d) => write(d, 'manifest.webmanifest', manifest({ icons: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }] })), /no 192x192 PNG icon/],
    ['icon file missing', (d) => rmSync(join(d, 'icons/icon-512.png')), /icon icons\/icon-512.png is missing/],
    ['icon wrong size', (d) => write(d, 'icons/icon-512.png', png(300)), /must be a 512x512 PNG/],
    ['manifest not linked', (d) => write(d, 'index.html', '<html><head></head><body></body></html>'), /does not link the web manifest/],
    ['no manifest file', (d) => rmSync(join(d, 'manifest.webmanifest')), /manifest.webmanifest is missing/],
    ['no service worker', (d) => rmSync(join(d, 'sw.js')), /sw.js is missing/],
    ['no fetch listener', (d) => writeFileSync(join(d, 'sw.js'), readFileSync(join(d, 'sw.js'), 'utf8').replace("addEventListener('fetch'", "addEventListener('other'")), /no fetch listener/],
    ['file changed after the build', (d) => write(d, 'app.1.js', 'navigator.serviceWorker.register("sw.js"); // edited'), /app\.1\.js does not match its revision/],
    ['precached file missing', (d) => rmSync(join(d, 'app.1.js')), /precached file app\.1\.js is missing/],
    ['nothing registers the worker', (d) => {
      write(d, 'app.1.js', 'console.log(1)');
      const sw = readFileSync(join(d, 'sw.js'), 'utf8');
      const revision = sha256Hex(readFileSync(join(d, 'app.1.js')));
      writeFileSync(join(d, 'sw.js'), sw.replace(/("url": "app\.1\.js",\s+"revision": ")[0-9a-f]+/, `$1${revision}`));
    }, /no script registers sw\.js/],
  ])('reports: %s', async (_name, tweak, expected) => {
    const r = await verifyInstallable(build(tweak));
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(expected);
  });
});
