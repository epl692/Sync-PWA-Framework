// The in-memory test transport must itself satisfy the contract it is used to test.
import { MemoryNetwork, transportContract, unsupportedTransport, type RemoteEnd } from '@sync/testkit';

transportContract('memory (testkit)', {
  async create() {
    const net = new MemoryNetwork();
    const transport = net.transport('local');
    const far = net.transport('remote');
    net.link('local', 'remote');
    const cbs: ((b: Uint8Array) => void)[] = [];
    far.on('message', (_p, b) => cbs.forEach((cb) => cb(b)));
    far.on('peerConnected', () => undefined);
    await far.start();
    const remote: RemoteEnd = {
      send: (bytes) => far.send('local', bytes),
      onMessage: (cb) => void cbs.push(cb),
      disconnect: () => net.sever('local', 'remote'),
      reconnect: () => net.restore('local', 'remote'),
    };
    return { transport, remote, teardown: async () => void (await transport.stop(), await far.stop()) };
  },
  createUnsupported: () => unsupportedTransport('unsupported-memory'),
  reconnects: true,
});
