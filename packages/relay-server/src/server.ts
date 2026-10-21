import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { RelayHub, type RelayHubOptions } from './relayHub';

export interface RelayServerOptions {
  port?: number;
  host?: string;
  hub?: RelayHubOptions;
}

export interface RelayServer {
  port: number;
  hub: RelayHub;
  close(): Promise<void>;
}

/** Start a WebSocket relay. Pass port 0 to pick a free port. */
export async function createRelayServer(opts: RelayServerOptions = {}): Promise<RelayServer> {
  const sockets = new Map<string, WebSocket>();
  const hub = new RelayHub((peerId, bytes) => {
    const ws = sockets.get(peerId);
    if (ws && ws.readyState === ws.OPEN) ws.send(bytes);
  }, opts.hub);
  const wss = new WebSocketServer({
    port: opts.port ?? 8787,
    host: opts.host,
    maxPayload: opts.hub?.maxMessageBytes ?? 4 * 1024 * 1024,
  });
  await new Promise<void>((resolveListening, reject) => {
    wss.once('listening', () => resolveListening());
    wss.once('error', reject);
  });
  let next = 0;
  wss.on('connection', (ws) => {
    const id = `c${++next}`;
    sockets.set(id, ws);
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return; // the protocol is binary-only
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      hub.onMessage(id, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    });
    ws.on('close', () => {
      sockets.delete(id);
      hub.onDisconnect(id);
    });
    ws.on('error', () => ws.terminate());
    hub.onConnect(id);
  });
  const address = wss.address();
  const port = typeof address === 'object' && address ? address.port : (opts.port ?? 8787);
  return {
    port,
    hub,
    close: () =>
      new Promise<void>((res) => {
        for (const ws of sockets.values()) ws.terminate();
        wss.close(() => res());
      }),
  };
}

// `npm run relay-server`
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const port = Number(process.env.PORT ?? 8787);
  createRelayServer({ port }).then((s) =>
    console.log(`relay listening on ws://localhost:${s.port} (in-memory, opaque store-and-forward)`),
  );
}
