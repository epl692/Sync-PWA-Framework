// Static server for e2e pages. Bundles tests/e2e/entry.ts with esbuild on startup.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const result = await build({
  entryPoints: ['tests/e2e/entry.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  write: false,
  tsconfig: 'tsconfig.json',
  conditions: ['browser'],
});
const bundle = result.outputFiles[0].text;
const html = readFileSync('tests/e2e/pages/index.html', 'utf8');

createServer((req, res) => {
  if (req.url === '/bundle.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(bundle);
  } else {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  }
}).listen(4173, () => console.log('e2e server on 4173'));
