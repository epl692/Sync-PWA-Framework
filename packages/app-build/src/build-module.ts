/** buildModule: one module in, one self-contained ES module file out (contracts/runtime-manifest.md, "Module file format"). */

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BuildError } from './build-app';
import { bannedForRuntimeModule, bannedImportsPlugin } from './banned-imports';

export interface BuildModuleOptions {
  /** Entry exporting `export default { id, version, ... }` (a module definition). */
  entry: string;
  outFile: string;
  /** When given, the result also carries the runtime manifest entry for this module, with this url. */
  manifestEntry?: { url: string };
}

export interface BuiltModule {
  integrity: string;
  id: string;
  version: string;
  manifestEntry?: { id: string; version: string; url: string; integrity: string };
}

export const integrityOf = (bytes: Uint8Array): string => `sha256-${createHash('sha256').update(bytes).digest('base64')}`;

/**
 * Single-file ESM with no imports. Fails when an import survives bundling (a dynamic `import(variable)`, for
 * example), when the file has no module definition as its default export, or when esbuild cannot resolve something.
 */
export async function buildModule(opts: BuildModuleOptions): Promise<BuiltModule> {
  const entry = resolve(opts.entry);
  const outFile = resolve(opts.outFile);

  const banned = bannedImportsPlugin({
    banned: bannedForRuntimeModule,
    because: 'a runtime module may import only types from @sync/* (a value import copies the framework into the file); use ModuleContext',
  });
  let result;
  try {
    result = await build({
      plugins: [banned.plugin],
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      conditions: ['browser'],
      minify: true,
      write: false,
      outfile: outFile,
      metafile: true,
      logLevel: 'silent',
    });
  } catch (e) {
    if (banned.problems.length) throw new BuildError(banned.problems);
    const errors = (e as { errors?: Array<{ text: string }> }).errors;
    throw new BuildError(errors?.length ? errors.map((x) => x.text) : [e instanceof Error ? e.message : String(e)]);
  }
  if (banned.problems.length) throw new BuildError(banned.problems);

  const output = result.outputFiles[0]!;
  const text = output.text;
  const problems: string[] = [];
  const outMeta = Object.values(result.metafile.outputs)[0];
  for (const imp of outMeta?.imports ?? []) problems.push(`${basename(entry)}: the bundle still imports ${JSON.stringify(imp.path)}`);
  if (/\bimport\s*\(/.test(text)) problems.push(`${basename(entry)}: the bundle contains a dynamic import(); a runtime module must be a single file with no imports`);
  if (problems.length) throw new BuildError(problems);

  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, output.contents);

  // read the id and version from the module itself, so the manifest can never disagree with the file
  let def: { id?: unknown; version?: unknown } | undefined;
  try {
    def = ((await import(`${pathToFileURL(outFile).href}?t=${Date.now()}`)) as { default?: { id?: unknown; version?: unknown } }).default;
  } catch (e) {
    throw new BuildError([`${basename(entry)}: the built file could not be loaded: ${e instanceof Error ? e.message : String(e)}`]);
  }
  if (!def || typeof def.id !== 'string' || typeof def.version !== 'string') {
    throw new BuildError([`${basename(entry)}: the default export must be a module definition with an id and a version`]);
  }

  const integrity = integrityOf(output.contents);
  return {
    integrity,
    id: def.id,
    version: def.version,
    ...(opts.manifestEntry ? { manifestEntry: { id: def.id, version: def.version, url: opts.manifestEntry.url, integrity } } : {}),
  };
}

/**
 * Build every `<configDir>/runtime-modules/<name>/index.ts` into `<outDir>/modules/<id>.<version>.js` and write
 * `<outDir>/modules/manifest.json`. Returns the written paths relative to `outDir`.
 */
export async function buildRuntimeModules(o: { configDir: string; outDir: string }): Promise<string[]> {
  const root = join(o.configDir, 'runtime-modules');
  let names: string[] = [];
  try {
    names = (await readdir(root)).sort();
  } catch {
    return [];
  }
  const modules: Array<{ id: string; version: string; url: string; integrity: string }> = [];
  const written: string[] = [];
  for (const name of names) {
    const entry = join(root, name, 'index.ts');
    if (!(await stat(entry).then((s) => s.isFile(), () => false))) continue;
    const tmp = join(o.outDir, 'modules', `.build-${name}.js`);
    const built = await buildModule({ entry, outFile: tmp });
    const file = `${built.id}.${built.version}.js`;
    const { rename } = await import('node:fs/promises');
    await rename(tmp, join(o.outDir, 'modules', file));
    modules.push({ id: built.id, version: built.version, url: file, integrity: built.integrity });
    written.push(`modules/${file}`);
  }
  if (!modules.length) return [];
  await writeFile(join(o.outDir, 'modules', 'manifest.json'), JSON.stringify({ v: 1, modules }, null, 2));
  return [...written, 'modules/manifest.json'];
}
