/** buildApp: an App Config in, static installable PWA files out (FR-013). */

import { build } from 'esbuild';
import { checkAppConfig, type AppConfig } from '@sync/modules';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DEFAULT_TEMPLATE, renderIndexHtml, renderWebManifest } from './emit';
import { sha256Hex } from './installable';
import { loadConfig } from './load-config';
import { readPngSize } from './png';
import { bannedForApp, bannedImportsPlugin } from './banned-imports';
import { generateServiceWorker } from './sw-template';
import { buildRuntimeModules } from './build-module';
import { existsSync } from 'node:fs';

export interface BuildAppOptions {
  /** Path to app.config.ts. */
  config: string;
  outDir: string;
  mode?: 'production' | 'development';
  /** Content-hash file names. Default true in production. */
  hash?: boolean;
}

export interface BuildResult {
  outDir: string;
  /** Every emitted file with its SHA-256 revision. */
  files: Array<{ path: string; bytes: number; revision: string }>;
  warnings: string[];
}

export class BuildError extends Error {
  constructor(readonly problems: string[]) {
    super(`build failed:\n- ${problems.join('\n- ')}`);
    this.name = 'BuildError';
  }
}

async function readIf(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch {
    return undefined;
  }
}

/** Problems that would make the icons unusable, each with the offending path. */
async function checkIcons(config: AppConfig, configDir: string): Promise<string[]> {
  const problems: string[] = [];
  const wanted: Array<[string | undefined, number, string]> = [
    [config.icons?.src192, 192, 'icons.src192'],
    [config.icons?.src512, 512, 'icons.src512'],
    [config.icons?.maskable512, 512, 'icons.maskable512'],
  ];
  for (const [path, size, label] of wanted) {
    if (!path) {
      if (label !== 'icons.maskable512') problems.push(`config.${label} is required`);
      continue;
    }
    const bytes = await readIf(resolve(configDir, path));
    if (!bytes) problems.push(`config.${label}: icon file ${path} not found`);
    else {
      const dim = readPngSize(bytes);
      if (!dim) problems.push(`config.${label}: ${path} is not a PNG`);
      else if (dim.width !== size || dim.height !== size) problems.push(`config.${label}: ${path} is ${dim.width}x${dim.height}, expected ${size}x${size}`);
    }
  }
  return problems;
}

export async function buildApp(opts: BuildAppOptions): Promise<BuildResult> {
  const mode = opts.mode ?? 'production';
  const hash = opts.hash ?? mode === 'production';
  const configPath = resolve(opts.config);
  const configDir = dirname(configPath);
  const outDir = resolve(opts.outDir);
  const warnings: string[] = [];

  // The config is run in Node first, so banned imports are looked for there too.
  const banned = bannedImportsPlugin({ banned: bannedForApp, because: 'modules reach data through ModuleContext (import only types from @sync/modules)' });
  let config: AppConfig;
  try {
    config = await loadConfig(configPath, banned.plugin);
  } catch (e) {
    if (banned.problems.length) throw new BuildError(banned.problems);
    const errors = (e as { errors?: Array<{ text: string }> }).errors;
    throw new BuildError(errors?.length ? errors.map((x) => x.text) : [e instanceof Error ? e.message : String(e)]);
  }
  if (banned.problems.length) throw new BuildError(banned.problems);
  const problems = [...checkAppConfig(config), ...(await checkIcons(config, configDir))];
  if (mode === 'production' && config.security === 'plaintext-for-tests') {
    problems.push('config.security "plaintext-for-tests" is not allowed in a production build');
  }
  if (problems.length) throw new BuildError(problems);

  // An app with no runtime-modules folder does not look for a manifest (no 404 on every start), unless it says otherwise.
  const hasRuntime = existsSync(join(configDir, 'runtime-modules'));
  const entry = [
    `import config from ${JSON.stringify(configPath)};`,
    `import { startApp } from '@sync/modules';`,
    hasRuntime ? 'const cfg = config;' : `const cfg = { ...config, runtime: { ...config.runtime, manifest: config.runtime?.manifest ?? false } };`,
    `(globalThis as { __syncHost?: unknown }).__syncHost = await startApp(cfg, { mode: ${JSON.stringify(mode)} });`,
  ].join('\n');
  const bundle = await build({
    entryPoints: { app: 'sync-app-entry' }, // a virtual module (below), so the output is named app.[hash].js
    plugins: [
      banned.plugin,
      {
        name: 'sync-app-entry',
        setup(b) {
          b.onResolve({ filter: /^sync-app-entry$/ }, () => ({ path: 'sync-app-entry', namespace: 'sync-app' }));
          b.onLoad({ filter: /.*/, namespace: 'sync-app' }, () => ({ contents: entry, loader: 'ts', resolveDir: configDir }));
        },
      },
    ],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    conditions: ['browser'],
    outdir: outDir,
    entryNames: hash ? '[name].[hash]' : '[name]',
    minify: mode === 'production',
    sourcemap: mode === 'production' ? false : 'linked',
    define: { 'process.env.NODE_ENV': JSON.stringify(mode) },
    metafile: true,
    write: false,
    logLevel: 'silent',
  });

  if (banned.problems.length) throw new BuildError(banned.problems);

  const out = new Map<string, Buffer | string>();
  const rel = (abs: string) => abs.slice(outDir.length + 1).split('\\').join('/');
  let script = '';
  const styles: string[] = [];
  for (const f of bundle.outputFiles) {
    const name = rel(f.path);
    out.set(name, Buffer.from(f.contents));
    if (name.endsWith('.js')) script = name;
    else if (name.endsWith('.css')) styles.push(name);
  }
  if (!script) throw new BuildError(['the bundler produced no JavaScript']);

  for (const [src, dest] of [
    [config.icons.src192, 'icons/icon-192.png'],
    [config.icons.src512, 'icons/icon-512.png'],
    ...(config.icons.maskable512 ? [[config.icons.maskable512, 'icons/maskable-512.png']] : []),
  ] as Array<[string, string]>) {
    out.set(dest, await readFile(resolve(configDir, src)));
  }
  for (const asset of config.assets ?? []) out.set(asset.split('\\').join('/'), await readFile(resolve(configDir, asset)));

  const template = (await readIf(join(configDir, 'index.template.html')))?.toString('utf8') ?? DEFAULT_TEMPLATE;
  out.set('index.html', renderIndexHtml({ template, config, script, styles, hasMaskable: !!config.icons.maskable512 }));
  out.set('manifest.webmanifest', renderWebManifest(config, !!config.icons.maskable512));

  const bytesOf = (v: Buffer | string) => (typeof v === 'string' ? Buffer.from(v, 'utf8') : v);
  const precache = [...out.entries()]
    .filter(([name]) => !name.endsWith('.map'))
    .map(([name, v]) => ({ url: name, revision: sha256Hex(bytesOf(v)) }))
    .sort((a, b) => (a.url < b.url ? -1 : 1));
  const buildId = sha256Hex(precache.map((f) => `${f.url}:${f.revision}`).join('\n')).slice(0, 16);
  out.set('sw.js', generateServiceWorker({ build: buildId, files: precache }));

  await rm(outDir, { recursive: true, force: true });
  const files: BuildResult['files'] = [];
  for (const [name, v] of [...out.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const bytes = bytesOf(v);
    await mkdir(dirname(join(outDir, name)), { recursive: true });
    await writeFile(join(outDir, name), bytes);
    files.push({ path: name, bytes: bytes.length, revision: sha256Hex(bytes) });
  }
  // Runtime modules are served next to the app but are not part of the shell: the loader caches them, not the worker.
  for (const path of await buildRuntimeModules({ configDir, outDir })) {
    const bytes = await readFile(join(outDir, path));
    files.push({ path, bytes: bytes.length, revision: sha256Hex(bytes) });
  }
  return { outDir, files, warnings };
}
