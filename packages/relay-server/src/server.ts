import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { BlobRelay, type BlobRelayOptions } from './blobRelay';
import { createFileBlobStorage } from './fileBlobStorage';
import { RelayHub, type RelayHubOptions } from './relayHub';

export interface RelayServerOptions {
  port?: number;
  host?: string;
  hub?: RelayHubOptions;
  /**
   * Store attachments (spec 004). `dir` is where ciphertext blobs are kept on disk; the caps and the idle period are those of
   * `BlobRelay`. Off unless given.
   */
  blobs?: { dir: string } & Omit<BlobRelayOptions, 'storage'>;
}

export interface RelayServer {
  port: number;
  hub: RelayHub;
  /** Present when blob storage is on. */
  blobRelay?: BlobRelay;
  close(): Promise<void>;
}

/** Start a WebSocket relay. Pass port 0 to pick a free port. */
export async function createRelayServer(opts: RelayServerOptions = {}): Promise<RelayServer> {
  const sockets = new Map<string, WebSocket>();
  const hub = new RelayHub((peerId, bytes) => {
    const ws = sockets.get(peerId);
    if (ws && ws.readyState === ws.OPEN) ws.send(bytes);
  }, opts.hub);
  const { dir, ...blobOpts } = opts.blobs ?? { dir: '' };
  const blobRelay = opts.blobs ? new BlobRelay(hub, { ...blobOpts, storage: await createFileBlobStorage(dir) }) : undefined;
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
    blobRelay,
    close: () =>
      new Promise<void>((res) => {
        blobRelay?.close();
        for (const ws of sockets.values()) ws.terminate();
        wss.close(() => res());
      }),
  };
}

// `npm run relay-server`. Attachment storage is on when BLOB_DIR is set (BLOB_MAX_BYTES, BLOB_TOTAL_BYTES, BLOB_PER_SPACE_BYTES, BLOB_TTL_DAYS tune it).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const port = Number(process.env.PORT ?? 8787);
  const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));
  const blobs = process.env.BLOB_DIR
    ? {
        dir: process.env.BLOB_DIR,
        maxBlobBytes: num(process.env.BLOB_MAX_BYTES),
        totalBytes: num(process.env.BLOB_TOTAL_BYTES),
        perSpaceBytes: num(process.env.BLOB_PER_SPACE_BYTES),
        ttlMs: num(process.env.BLOB_TTL_DAYS) === undefined ? undefined : num(process.env.BLOB_TTL_DAYS)! * 24 * 60 * 60 * 1000,
      }
    : undefined;
  createRelayServer({ port, blobs }).then((s) =>
    console.log(`relay listening on ws://localhost:${s.port} (opaque store-and-forward${blobs ? `, blobs in ${blobs.dir}` : ''})`),
  );
}
