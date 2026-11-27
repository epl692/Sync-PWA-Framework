// Spec 005 T054: the sidecar bridge client speaks the JSON-lines protocol and passes the BleBridge contract (against a fake sidecar).
import { describe, expect, it } from 'vitest';
import { LINK_UUIDS, MemoryBleLink, MockBleBridge, bleBridgeContract, createFakeSidecar, type CentralDriver } from '@sync/testkit';
import { MAX_LINE_BYTES, createSidecarBridge, type BleBridge } from '../src';

bleBridgeContract('SidecarBridge over a fake sidecar', {
  async create() {
    const link = new MemoryBleLink({ mtu: 185 });
    const inner = new MockBleBridge(link);
    const sidecar = createFakeSidecar(inner);
    const bridge = await createSidecarBridge(sidecar.proc);
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
        const services = async () => {
          dev ??= await bt.requestDevice({ filters: [{ services: [LINK_UUIDS.serviceUuid] }] });
          const server = await dev.gatt.connect();
          const svc = await server.getPrimaryService(LINK_UUIDS.serviceUuid);
          info = await svc.getCharacteristic(LINK_UUIDS.infoUuid);
          tx = await svc.getCharacteristic(LINK_UUIDS.txUuid);
          rx = await svc.getCharacteristic(LINK_UUIDS.rxUuid);
        };
        return {
          mtu: 185,
          async readInfo() {
            await services();
            const v = await info.readValue();
            dev.gatt.disconnect();
            return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
          },
          async connect() {
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

describe('sidecar protocol', () => {
  const setup = async (o?: Parameters<typeof createFakeSidecar>[1]) => {
    const link = new MemoryBleLink({ mtu: 185 });
    const inner = new MockBleBridge(link);
    const sidecar = createFakeSidecar(inner, o);
    return { link, inner, sidecar, bridge: (await createSidecarBridge(sidecar.proc, { helloTimeoutMs: 500, requestTimeoutMs: 500 })) as BleBridge };
  };

  it('waits for hello and exposes the helper\'s name and version', async () => {
    const { bridge } = await setup({ bridgeName: 'windows' });
    expect((bridge as unknown as { bridgeName: string }).bridgeName).toBe('windows');
    expect((bridge as unknown as { version: number }).version).toBe(1);
  });

  it('refuses a helper that speaks a version it does not know, and kills it', async () => {
    const link = new MemoryBleLink();
    const sidecar = createFakeSidecar(new MockBleBridge(link), { version: 9 });
    await expect(createSidecarBridge(sidecar.proc, { helloTimeoutMs: 500 })).rejects.toMatchObject({ code: 'bridge-failed' });
    expect(sidecar.killed).toBe(true);
  });

  it('gives up if the helper never says hello', async () => {
    const link = new MemoryBleLink();
    const sidecar = createFakeSidecar(new MockBleBridge(link), { sayHello: false });
    await expect(createSidecarBridge(sidecar.proc, { helloTimeoutMs: 50 })).rejects.toMatchObject({ code: 'bridge-failed' });
  });

  it('sends one JSON object per line with an id and an op, binary as base64', async () => {
    const { bridge, sidecar } = await setup();
    await bridge.startAdvertising({ ...LINK_UUIDS, name: 'x', info: Uint8Array.of(1, 2, 3), maxConnections: 2 });
    const m = sidecar.received.find((r) => r.op === 'startAdvertising')!;
    expect(typeof m.id).toBe('number');
    expect(m.info).toBe('AQID');
    expect(m.maxConnections).toBe(2);
  });

  it('a helper that crashes fails pending requests and reports every connection as gone', async () => {
    const { bridge, sidecar, link } = await setup();
    const gone: string[] = [];
    bridge.on('disconnected', (c) => gone.push(c));
    await bridge.startAdvertising({ ...LINK_UUIDS, name: 'x', info: new Uint8Array(1), maxConnections: 2 });
    const bt = link.bluetooth();
    const dev = await bt.requestDevice({ filters: [{ services: [LINK_UUIDS.serviceUuid] }] });
    await dev.gatt.connect();
    await new Promise((r) => setTimeout(r, 20));
    sidecar.crash();
    expect(gone).toHaveLength(1);
    await expect(bridge.setInfo(new Uint8Array(1))).rejects.toMatchObject({ code: 'bridge-failed' });
    expect((await bridge.support()).peripheral.ok).toBe(false);
  });

  it('an oversized or non-JSON line from the helper is a protocol error that stops the bridge', async () => {
    const { bridge, sidecar } = await setup();
    sidecar.raw('x'.repeat(MAX_LINE_BYTES + 1));
    await expect(bridge.setInfo(new Uint8Array(1))).rejects.toBeDefined();
    const second = await setup();
    second.sidecar.raw('not json');
    await expect(second.bridge.setInfo(new Uint8Array(1))).rejects.toBeDefined();
  });

  it('ignores events from a newer helper that it does not know', async () => {
    const { bridge, sidecar } = await setup();
    sidecar.raw(JSON.stringify({ event: 'battery', level: 12 }));
    await bridge.setInfo(new Uint8Array(1)); // still fine
  });

  it('a request the helper never answers times out', async () => {
    const link = new MemoryBleLink();
    const inner = new MockBleBridge(link);
    const sidecar = createFakeSidecar(inner);
    const realWrite = sidecar.proc.write;
    const bridge = await createSidecarBridge(sidecar.proc, { requestTimeoutMs: 50 });
    sidecar.proc.write = (line: string) => void (JSON.parse(line).op === 'setInfo' ? undefined : realWrite(line));
    await expect(bridge.setInfo(new Uint8Array(1))).rejects.toMatchObject({ code: 'bridge-failed' });
  });
});
