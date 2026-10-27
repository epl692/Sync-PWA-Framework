// T059: buildApp output and its error reporting.
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BuildError, buildApp } from '../src/build-app';
import { cleanup, makeApp, tmpDir } from './helpers';

afterAll(cleanup);
const read = (dir: string, f: string) => readFileSync(join(dir, f), 'utf8');

describe('buildApp', () => {
  it('emits the shell, manifest, worker and icons, all with relative URLs', async () => {
    const app = makeApp();
    const out = tmpDir('out');
    const r = await buildApp({ config: app.config, outDir: out });
    const names = readdirSync(out).sort();
    expect(names).toEqual(expect.arrayContaining(['index.html', 'manifest.webmanifest', 'sw.js', 'icons']));
    const script = names.find((n) => /^app\.[A-Za-z0-9]+\.js$/.test(n))!;
    expect(script).toBeDefined();
    expect(r.files.map((f) => f.path)).toEqual(expect.arrayContaining([script, 'index.html', 'manifest.webmanifest', 'sw.js', 'icons/icon-192.png', 'icons/icon-512.png']));
    const html = read(out, 'index.html');
    expect(html).toContain(`src="${script}"`);
    expect(html).toContain('<link rel="manifest" href="manifest.webmanifest"');
    expect(html).toContain('<meta name="theme-color" content="#123456"');
    for (const [, url] of html.matchAll(/(?:href|src)="([^"]+)"/g)) expect(url, url).not.toMatch(/^\/|^https?:/);
    const manifest = JSON.parse(read(out, 'manifest.webmanifest'));
    expect(manifest).toMatchObject({ name: 'Fixture', start_url: './', scope: './', display: 'standalone', theme_color: '#123456' });
    expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(['192x192', '512x512']);
    expect(r.files.find((f) => f.path === 'sw.js')).toBeDefined();
  });

  it('puts a strict CSP in the page: connect-src is self plus the configured origins only', async () => {
    const app = makeApp({ extra: "connectSrc: ['wss://relay.example.test']," });
    const out = tmpDir('out');
    await buildApp({ config: app.config, outDir: out });
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(read(out, 'index.html'))![1]!;
    expect(csp).toContain("script-src 'self' blob:");
    expect(csp).toContain("connect-src 'self' wss://relay.example.test;");
    expect(csp).not.toMatch(/connect-src[^;]*\b(ws:|wss:|https:)(?!\/\/)/);
  });

  it('uses the app’s own index.template.html', async () => {
    const app = makeApp({ template: '<!doctype html><html><head><title>Mine</title></head><body><main id="x"></main></body></html>' });
    const out = tmpDir('out');
    await buildApp({ config: app.config, outDir: out });
    const html = read(out, 'index.html');
    expect(html).toContain('<main id="x"></main>');
    expect(html).toContain('<title>Mine</title>');
  });

  it('changes the file hash when the content changes, and keeps it when it does not', async () => {
    const app = makeApp({ modules: `[{ id: "plain", version: "1.0.0" }]` });
    const scriptOf = async () => (await buildApp({ config: app.config, outDir: tmpDir('out') })).files.find((f) => /^app\..+\.js$/.test(f.path))!.path;
    const a = await scriptOf();
    expect(await scriptOf()).toBe(a);
    writeFileSync(app.config, readFileSync(app.config, 'utf8').replace('"1.0.0"', '"1.0.1"'));
    expect(await scriptOf()).not.toBe(a);
  });

  it('keeps the host off the page in production (a module could use it to reach the core), and publishes it on request or in development', async () => {
    const app = makeApp();
    const prod = tmpDir('out');
    const dev = tmpDir('out');
    const exposed = tmpDir('out');
    await buildApp({ config: app.config, outDir: prod });
    await buildApp({ config: app.config, outDir: dev, mode: 'development' });
    await buildApp({ config: app.config, outDir: exposed, exposeHost: true });
    const js = (dir: string) => read(dir, readdirSync(dir).find((n) => /^app(\..+)?\.js$/.test(n))!);
    expect(js(prod)).not.toContain('__syncHost');
    expect(js(dev)).toContain('__syncHost');
    expect(js(exposed)).toContain('__syncHost');
  });

  it('does not hash names in development, and keeps source maps out of the precache', async () => {
    const app = makeApp();
    const out = tmpDir('out');
    await buildApp({ config: app.config, outDir: out, mode: 'development' });
    expect(existsSync(join(out, 'app.js'))).toBe(true);
    expect(existsSync(join(out, 'app.js.map'))).toBe(true);
    expect(read(out, 'sw.js')).not.toContain('.js.map');
  });
});

describe('buildApp problems (all listed together)', () => {
  const failure = async (app: ReturnType<typeof makeApp>, mode?: 'production' | 'development') => {
    const e = await buildApp({ config: app.config, outDir: tmpDir('out'), mode }).then(() => undefined, (x) => x);
    expect(e).toBeInstanceOf(BuildError);
    return (e as BuildError).problems;
  };

  it('reports an invalid definition, a lint failure, a duplicate id and bad icons in one go', async () => {
    const app = makeApp({
      modules: `[
        { id: "Bad Id", version: "1.0.0" },
        { id: "dupe", version: "1.0.0" },
        { id: "dupe", version: "1.1.0" },
        { id: "schemas", version: "1.0.0", provides: { types: [{ name: "broken", versions: [] }] } },
      ]`,
      icon192: 100,
      skipIcon512: true,
    });
    const problems = (await failure(app)).join('\n');
    expect(problems).toMatch(/module "Bad Id" failed: .*id "Bad Id"/);
    expect(problems).toMatch(/duplicate module id "dupe"/);
    expect(problems).toMatch(/module "schemas": type "broken": needs at least one version/);
    expect(problems).toMatch(/icons\.src192: icons\/i192\.png is 100x100, expected 192x192/);
    expect(problems).toMatch(/icons\.src512: icon file icons\/i512\.png not found/);
  });

  it('reports an unsatisfiable dependency inside the bundle', async () => {
    const app = makeApp({ modules: `[{ id: "one", version: "1.0.0", dependencies: { ghost: "^1.0.0" } }]` });
    expect((await failure(app)).join('\n')).toMatch(/module "one" skipped: missing dependency "ghost"/);
  });

  it('refuses the plaintext test codec in production, and allows it in development', async () => {
    const app = makeApp({ security: 'plaintext-for-tests' });
    expect((await failure(app)).join('\n')).toMatch(/plaintext-for-tests.*production/);
    const r = await buildApp({ config: app.config, outDir: tmpDir('out'), mode: 'development' });
    expect(r.files.length).toBeGreaterThan(3);
  });

  it('refuses a template without </head> and </body>', async () => {
    const app = makeApp({ template: '<main></main>' });
    await expect(buildApp({ config: app.config, outDir: tmpDir('out') })).rejects.toThrow(/<\/head>/);
  });
});
