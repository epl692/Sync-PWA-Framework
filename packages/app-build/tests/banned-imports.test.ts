// T088: framework internals cannot be imported by module code (research R-10).
import { afterAll, describe, expect, it } from 'vitest';
import { BuildError, buildApp } from '../src/build-app';
import { buildModule } from '../src/build-module';
import { cleanup, makeApp, tmpDir, write } from './helpers';
import { join } from 'node:path';

afterAll(cleanup);

const failure = async (run: () => Promise<unknown>) => {
  const e = await run().then(() => undefined, (x) => x);
  expect(e).toBeInstanceOf(BuildError);
  return (e as BuildError).problems.join('\n');
};

/** An app whose only module lives in modules/thing.ts with the given source. */
function appWith(source: string) {
  const app = makeApp({ modules: '[thing]' });
  write(app.dir, 'modules/thing.ts', source);
  write(app.dir, 'app.config.ts', readConfig(app).replace('export default {', "import thing from './modules/thing';\nexport default {"));
  return app;
}
import { readFileSync } from 'node:fs';
const readConfig = (app: { config: string }) => readFileSync(app.config, 'utf8');

describe('buildApp', () => {
  it.each(['@sync/core', '@sync/spaces', '@sync/testkit', '@sync/relay-server'])('refuses module code that imports %s', async (pkg) => {
    const app = appWith(`import * as fw from '${pkg}';\nexport default { id: 'thing', version: '1.0.0', activate: () => void fw };`);
    const msg = await failure(() => buildApp({ config: app.config, outDir: tmpDir('out') }));
    expect(msg).toContain('modules/thing.ts');
    expect(msg).toContain(`"${pkg}"`);
    expect(msg).toMatch(/ModuleContext/);
  });

  it('refuses a subpath of an internal package too', async () => {
    const app = appWith(`import { x } from '@sync/core/src/index';\nexport default { id: 'thing', version: '1.0.0', x };`);
    expect(await failure(() => buildApp({ config: app.config, outDir: tmpDir('out') }))).toContain('@sync/core/src/index');
  });

  it('allows type-only imports of anything, value imports of @sync/modules, and the infrastructure packages', async () => {
    const app = appWith(
      [
        `import type { SyncCore } from '@sync/core';`,
        `import type { ModuleDefinition } from '@sync/modules';`,
        `import { defineModule } from '@sync/modules';`,
        `import { createInviteProvider } from '@sync/identity-invite';`,
        `export default defineModule({ id: 'thing', version: '1.0.0', provides: { identityProviders: [{ id: 'p', create: () => createInviteProvider() }] } } satisfies ModuleDefinition);`,
        `export type Unused = SyncCore;`,
      ].join('\n'),
    );
    const r = await buildApp({ config: app.config, outDir: tmpDir('out') });
    expect(r.files.length).toBeGreaterThan(3);
  });

  it('does not flag the framework’s own sources', async () => {
    // @sync/modules itself imports @sync/core and @sync/spaces; the check is about the app's code only
    const app = makeApp();
    await expect(buildApp({ config: app.config, outDir: tmpDir('out') })).resolves.toBeDefined();
  });
});

describe('buildModule (runtime modules)', () => {
  const build = (source: string) => {
    const dir = tmpDir('rm');
    write(dir, 'index.ts', source);
    return buildModule({ entry: join(dir, 'index.ts'), outFile: join(dir, 'out.js') });
  };

  it.each(['@sync/core', '@sync/spaces', '@sync/modules', '@sync/identity-invite'])('refuses any value import of %s: it would copy the framework into the module', async (pkg) => {
    const msg = await failure(() => build(`import * as fw from '${pkg}';\nexport default { id: 'notes', version: '1.0.0', activate: () => void fw };`));
    expect(msg).toContain(`"${pkg}"`);
    expect(msg).toMatch(/type/i);
  });

  it('allows type-only imports', async () => {
    const r = await build(`import type { ModuleDefinition } from '@sync/modules';\nimport type { SyncCore } from '@sync/core';\nexport default { id: 'notes', version: '1.0.0' } satisfies ModuleDefinition;\nexport type X = SyncCore;`);
    expect(r.id).toBe('notes');
  });
});
