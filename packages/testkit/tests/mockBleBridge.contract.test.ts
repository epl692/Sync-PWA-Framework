// Spec 005 T025: the mock bridge passes the BleBridge contract suite through the simulator.
import { MemoryBleLink } from '../src/ble/memoryBleLink';
import { MockBleBridge } from '../src/ble/mockBleBridge';
import { LINK_UUIDS, bleBridgeContract, type CentralDriver } from '../src/ble/bleBridgeContract';

bleBridgeContract('MockBleBridge on MemoryBleLink', {
  async create() {
    const link = new MemoryBleLink({ mtu: 185 });
    const bridge = new MockBleBridge(link);
    return {
      bridge,
      setBluetooth: async (on) => void link.setPower(on),
      teardown: async () => void (await bridge.close()),
      async newCentral(): Promise<CentralDriver> {
        const bt = link.bluetooth();
        let tx: any;
        let rx: any;
        let info: any;
        let dev: any;
        const cbs: Array<(f: Uint8Array) => void> = [];
        const prepare = async () => {
          if (dev) return;
          dev = await bt.requestDevice({ filters: [{ services: [LINK_UUIDS.serviceUuid] }] });
        };
        const services = async () => {
          const server = await dev.gatt.connect();
          const svc = await server.getPrimaryService(LINK_UUIDS.serviceUuid);
          info = await svc.getCharacteristic(LINK_UUIDS.infoUuid);
          tx = await svc.getCharacteristic(LINK_UUIDS.txUuid);
          rx = await svc.getCharacteristic(LINK_UUIDS.rxUuid);
        };
        return {
          mtu: 185,
          async readInfo() {
            await prepare();
            await services();
            const v = await info.readValue();
            dev.gatt.disconnect();
            return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
          },
          async connect() {
            await prepare();
            await services();
            rx.addEventListener('characteristicvaluechanged', (e: any) => {
              const v: DataView = e.target.value;
              const b = new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
              cbs.forEach((f) => f(b));
            });
            await rx.startNotifications();
          },
          write: (f) => tx.writeValueWithoutResponse(f),
          onNotify: (cb) => void cbs.push(cb),
          disconnect: async () => void dev?.gatt.disconnect(),
        };
      },
    };
  },
});
