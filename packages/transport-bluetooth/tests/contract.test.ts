// Spec 005 T035: the Bluetooth transport against the shared Transport and lane contract suites, through the radio simulator,
// at MTU 23, 185 and 247, with 1% frame loss on notifications and with duplicated frames (the link must tolerate both).
import { createLinkFixture, transportContract, type RemoteEnd } from '@sync/testkit';
import { createBluetoothTransport, createMemoryTrustStore, type BluetoothTransport } from '../src/index';

const variants: Array<{ name: string; air: Parameters<typeof createLinkFixture>[0] extends infer T ? T : never; large: number }> = [
  { name: 'MTU 23', air: { air: { mtu: 23 } }, large: 24 * 1024 },
  { name: 'MTU 185', air: { air: { mtu: 185 } }, large: 256 * 1024 },
  { name: 'MTU 247', air: { air: { mtu: 247 } }, large: 512 * 1024 },
];

for (const v of variants) {
  transportContract(`bluetooth via MemoryBleLink (${v.name})`, {
    largeMessageBytes: v.large,
    async create() {
      const fx = await createLinkFixture(v.air as never);
      const transport = createBluetoothTransport({
        proofs: await fx.newClient('phone'),
        confirmHub: async () => true,
        trustStore: createMemoryTrustStore(),
        bluetooth: fx.link.bluetooth() as never,
        isSecureContext: true,
      });
      const listeners: Array<(b: Uint8Array) => void> = [];
      fx.onCore((_p, b) => listeners.forEach((l) => l(b)));
      const remote: RemoteEnd = {
        send: async (bytes) => fx.server.send(fx.peers.at(-1)!.id, bytes),
        onMessage: (cb) => void listeners.push(cb),
        disconnect: async () => fx.bridge.disconnect(fx.peers.at(-1)!.conn),
        // a reserved-type frame straight onto the notify characteristic: not a valid frame
        injectCorrupt: async () => fx.bridge.notify(fx.peers.at(-1)!.conn, Uint8Array.of(0xff, 0xff, 1, 2, 3, 4, 5, 6)),
      };
      return { transport, remote, teardown: async () => void (await transport.stop(), await fx.stop()) };
    },
    async afterStart(t) {
      await (t as BluetoothTransport).chooseHub();
    },
    createUnsupported: () => createBluetoothTransport({ proofs: undefined as never, confirmHub: async () => false, trustStore: createMemoryTrustStore() }),
  });
}
