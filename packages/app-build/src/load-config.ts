/** Evaluates an `app.config.ts` in Node: bundle it with esbuild, import the result. */

import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppConfig } from '@sync/modules';

export async function loadConfig(configPath: string): Promise<AppConfig> {
  const dir = await mkdtemp(join(tmpdir(), 'sync-config-'));
  const outfile = join(dir, 'config.mjs');
  try {
    await build({
      entryPoints: [resolve(configPath)],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      outfile,
      logLevel: 'silent',
      // the bundle can contain CommonJS packages that use require()
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    });
    const mod = (await import(pathToFileURL(outfile).href)) as { default?: AppConfig };
    if (!mod.default || typeof mod.default !== 'object') throw new Error(`${configPath} must export an App Config as its default export`);
    return mod.default;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
