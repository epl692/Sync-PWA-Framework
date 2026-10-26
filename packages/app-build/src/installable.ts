/** Static installability checks of a build output (contracts/pwa-output.md). */

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readPngSize } from './png';

export interface InstallableReport {
  ok: boolean;
  problems: string[];
}

export const sha256Hex = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

async function exists(p: string): Promise<Buffer | undefined> {
  try {
    return await readFile(p);
  } catch {
    return undefined;
  }
}

/** Does `rel` stay inside the app (no `..`, not absolute, not another origin)? */
const insideApp = (rel: string) => !/^[a-z][a-z0-9+.-]*:/i.test(rel) && !rel.startsWith('/') && !rel.split('/').includes('..');

export async function verifyInstallable(outDir: string): Promise<InstallableReport> {
  const problems: string[] = [];

  const html = (await exists(join(outDir, 'index.html')))?.toString('utf8');
  if (!html) problems.push('index.html is missing');
  else if (!/<link[^>]+rel=["']manifest["'][^>]*>/i.test(html)) problems.push('index.html does not link the web manifest');

  const manifestBytes = await exists(join(outDir, 'manifest.webmanifest'));
  if (!manifestBytes) {
    problems.push('manifest.webmanifest is missing');
  } else {
    let m: Record<string, unknown> | undefined;
    try {
      m = JSON.parse(manifestBytes.toString('utf8'));
    } catch {
      problems.push('manifest.webmanifest is not valid JSON');
    }
    if (m) {
      if (!m.name && !m.short_name) problems.push('manifest has neither name nor short_name');
      if (typeof m.start_url !== 'string') problems.push('manifest has no start_url');
      else if (!insideApp(m.start_url)) problems.push(`manifest start_url ${JSON.stringify(m.start_url)} is outside the app`);
      if (typeof m.scope === 'string' && !insideApp(m.scope)) problems.push(`manifest scope ${JSON.stringify(m.scope)} is outside the app`);
      if (!['standalone', 'fullscreen', 'minimal-ui'].includes(String(m.display))) problems.push(`manifest display ${JSON.stringify(m.display)} must be standalone, fullscreen or minimal-ui`);
      const icons = Array.isArray(m.icons) ? (m.icons as Array<{ src?: string; sizes?: string; type?: string }>) : [];
      for (const size of [192, 512]) {
        const icon = icons.find((i) => i.sizes === `${size}x${size}` && i.type === 'image/png');
        if (!icon?.src) {
          problems.push(`manifest has no ${size}x${size} PNG icon`);
          continue;
        }
        const bytes = await exists(join(outDir, icon.src));
        if (!bytes) problems.push(`icon ${icon.src} is missing`);
        else {
          const dim = readPngSize(bytes);
          if (!dim || dim.width !== size || dim.height !== size) problems.push(`icon ${icon.src} must be a ${size}x${size} PNG`);
        }
      }
    }
  }

  const sw = (await exists(join(outDir, 'sw.js')))?.toString('utf8');
  if (!sw) {
    problems.push('sw.js is missing');
  } else {
    if (!/addEventListener\(\s*['"]fetch['"]/.test(sw)) problems.push('sw.js has no fetch listener');
    const list = /const PRECACHE = (\[[\s\S]*?\n\]);/.exec(sw);
    if (!list) {
      problems.push('sw.js has no precache list');
    } else {
      for (const f of JSON.parse(list[1]!) as Array<{ url: string; revision: string }>) {
        const bytes = await exists(join(outDir, f.url));
        if (!bytes) problems.push(`precached file ${f.url} is missing`);
        else if (sha256Hex(bytes) !== f.revision) problems.push(`precached file ${f.url} does not match its revision`);
      }
    }
    const scripts = (await readdir(outDir)).filter((n) => n.endsWith('.js') && n !== 'sw.js');
    let registers = false;
    for (const s of scripts) if ((await readFile(join(outDir, s), 'utf8')).includes('sw.js')) registers = true;
    if (!registers) problems.push('no script registers sw.js');
  }

  return { ok: problems.length === 0, problems };
}
