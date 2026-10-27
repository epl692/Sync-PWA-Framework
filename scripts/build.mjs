// Bundles each package's entry point to dist/ as an ES module (static-hostable output).
import { build } from 'esbuild';
import { readdirSync, existsSync } from 'node:fs';

const external = ['ws', 'esbuild'];
for (const name of readdirSync('packages')) {
  const entry = `packages/${name}/src/index.ts`;
  if (!existsSync(entry)) continue;
  await build({
    entryPoints: [entry],
    outfile: `packages/${name}/dist/index.js`,
    bundle: true,
    format: 'esm',
    platform: name === 'relay-server' || name === 'app-build' ? 'node' : 'browser',
    target: 'es2022',
    sourcemap: true,
    external,
    // keep workspace packages external except in browser bundles built by apps
    plugins: [{
      name: 'externalize-sync',
      setup(b) {
        b.onResolve({ filter: /^@sync\// }, (a) => (a.path === `@sync/${name}` ? null : { path: a.path, external: true }));
      },
    }],
  });
  console.log('built', name);
}
