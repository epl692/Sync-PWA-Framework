// T045: the WebSocket transport against the shared contract suite.
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { transportContract, type RemoteEnd } from '@sync/testkit';
import { createWebSocketTransport } from '../src/index';

transportContract('websocket client', {
  reconnects: true,
  async create() {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    const port = (wss.address() as { port: number }).port;

    const listeners: ((b: Uint8Array) => void)[] = [];
    let current: WsSocket | undefined;
    let waiting: ((s: WsSocket) => void)[] = [];
    wss.on('connection', (s) => {
      current = s;
      s.on('message', (d) => {
        const buf = Buffer.isBuffer(d) ? d : Buffer.concat(d as Buffer[]);
        for (const l of listeners) l(new Uint8Array(buf));
      });
      waiting.forEach((w) => w(s));
      waiting = [];
    });
    const nextConnection = () => new Promise<WsSocket>((r) => waiting.push(r));

    const transport = createWebSocketTransport({ url: `ws://127.0.0.1:${port}`, reconnect: { minMs: 20, maxMs: 100 } });
    const first = nextConnection();
    const remote: RemoteEnd = {
      async send(bytes) {
        await first;
        current!.send(bytes);
      },
      onMessage: (cb) => void listeners.push(cb),
      disconnect: () => void current?.terminate(),
      reconnect: async () => void (await (current && current.readyState === 1 ? Promise.resolve(current) : nextConnection())),
    };
    return {
      transport,
      remote,
      teardown: async () => {
        await transport.stop();
        for (const c of wss.clients) c.terminate();
        await new Promise<void>((r) => wss.close(() => r()));
      },
    };
  },
  createUnsupported: () => createWebSocketTransport({ url: 'ws://127.0.0.1:1', WebSocket: null }),
});
