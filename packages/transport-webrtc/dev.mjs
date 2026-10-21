// `npm run dev -w @sync/transport-webrtc`: serves the pairing demo on http://localhost:5174
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const bundle = (
  await build({
    entryPoints: [join(here, 'demo', 'demo.ts')],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    write: false,
    tsconfig: join(root, 'tsconfig.json'),
    conditions: ['browser'],
  })
).outputFiles[0].text;
const html = readFileSync(join(here, 'demo', 'index.html'), 'utf8');

createServer((req, res) => {
  if (req.url === '/demo.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(bundle);
  } else {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  }
}).listen(5174, () => console.log('WebRTC pairing demo on http://localhost:5174 (open it on two devices)'));
