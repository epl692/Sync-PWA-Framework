import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { encodePng } from '../src/png';

// Inside the repo so that `@sync/modules` resolves through the workspace's node_modules.
const TMP = join(__dirname, '.tmp');
const made: string[] = [];

export const png = (size: number) => encodePng(size, size, () => [43, 108, 176, 255]);

export function tmpDir(prefix = 't'): string {
  mkdirSync(TMP, { recursive: true });
  const d = mkdtempSync(join(TMP, `${prefix}-`));
  made.push(d);
  return d;
}

export function cleanup(): void {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function write(dir: string, rel: string, content: string | Uint8Array): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

export interface App {
  dir: string;
  config: string;
}

/** A small app: a config module plus icons. `modules` is TypeScript source for the `modules` array. */
export function makeApp(opts: { modules?: string; extra?: string; icon192?: number; icon512?: number; skipIcon512?: boolean; security?: string; template?: string } = {}): App {
  const dir = tmpDir('app');
  write(dir, 'icons/i192.png', png(opts.icon192 ?? 192));
  if (!opts.skipIcon512) write(dir, 'icons/i512.png', png(opts.icon512 ?? 512));
  write(
    dir,
    'app.config.ts',
    `export default {
  name: 'Fixture',
  themeColor: '#123456',
  icons: { src192: 'icons/i192.png', src512: 'icons/i512.png' },
  modules: ${opts.modules ?? '[{ id: "plain", version: "1.0.0" }]'},
  ${opts.security ? `security: '${opts.security}',` : ''}
  ${opts.extra ?? ''}
};\n`,
  );
  if (opts.template) write(dir, 'index.template.html', opts.template);
  return { dir, config: join(dir, 'app.config.ts') };
}
