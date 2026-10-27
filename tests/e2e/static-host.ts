// The simplest possible static host for e2e: files under a URL prefix, nothing else. No rewrites, no API, no special headers.
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

export function staticHost(dir: string, prefix: string, onRequest?: (path: string) => void): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
      onRequest?.(path);
      if (!path.startsWith(prefix)) return void res.writeHead(404).end();
      let rel = normalize('/' + path.slice(prefix.length)).slice(1); // no way out of the folder
      if (rel === '' || rel.endsWith('/')) rel += 'index.html';
      const file = join(dir, rel);
      if (!existsSync(file) || !statSync(file).isFile()) return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://localhost:${(server.address() as { port: number }).port}` }));
  });
}
