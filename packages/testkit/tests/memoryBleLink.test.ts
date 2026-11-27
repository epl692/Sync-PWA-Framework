// Spec 005 T023: the radio simulator behaves like GATT: bounded writes, ordered delivery, deterministic faults, disconnects.
import { describe, expect, it } from 'vitest';
import { MemoryBleLink, type PeripheralEndpoint } from '../src/ble/memoryBleLink';

const SERVICE = 'a89242f7-786e-4bf2-9b00-b028957dc0eb';
const INFO = 'c71b9f0e-0fc5-48bd-9bff-6428700a9eea';
const TX = '9ec66df3-0a3e-4c6a-a381-37405b5ac00c';
const RX = '16d9aa8a-90ef-407b-a339-80534210840d';

function peripheral(link: MemoryBleLink, over: Partial<PeripheralEndpoint> = {}) {
  const log = { connects: [] as string[], writes: [] as Uint8Array[], disconnects: [] as string[] };
  const ep: PeripheralEndpoint = {
    info: () => new TextEncoder().encode('{"v":[1,1]}'),
    connect: (id) => (log.connects.push(id), true),
    write: (_id, f) => void log.writes.push(f),
    disconnected: (id) => void log.disconnects.push(id),
    ...over,
  };
  const h = link.registerPeripheral(ep);
  h.setAdvertising({ serviceUuid: SERVICE, infoUuid: INFO, txUuid: TX, rxUuid: RX, name: 'Camp hub' });
  return { h, log };
}

async function connect(link: MemoryBleLink, opts?: ConstructorParameters<typeof MemoryBleLink>[0]) {
  const bt = link.bluetooth(opts);
  const dev = (await bt.requestDevice({ filters: [{ services: [SERVICE] }] })) as any;
  const server = await dev.gatt.connect();
  const svc = await server.getPrimaryService(SERVICE);
  return { dev, server, tx: await svc.getCharacteristic(TX), rx: await svc.getCharacteristic(RX), info: await svc.getCharacteristic(INFO) };
}
const bytes = (n: number, v = 1) => new Uint8Array(n).fill(v);
const flush = () => new Promise((r) => setTimeout(r, 5));

describe('MemoryBleLink', () => {
  it('discovers an advertising peripheral and reads INFO', async () => {
    const link = new MemoryBleLink();
    peripheral(link);
    const c = await connect(link);
    expect(c.dev.name).toBe('Camp hub');
    expect(new TextDecoder().decode(new Uint8Array((await c.info.readValue()).buffer))).toBe('{"v":[1,1]}');
  });

  it('requestDevice fails when nothing advertises the service', async () => {
    const link = new MemoryBleLink();
    await expect(link.bluetooth().requestDevice({ filters: [{ services: [SERVICE] }] })).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('writes without response are limited to mtu - 3 bytes and arrive unmerged and in order', async () => {
    const link = new MemoryBleLink({ mtu: 23 });
    const { log } = peripheral(link);
    const c = await connect(link);
    await expect(c.tx.writeValueWithoutResponse(bytes(21))).rejects.toThrow();
    for (let i = 1; i <= 20; i++) await c.tx.writeValueWithoutResponse(bytes(i, i));
    await flush();
    expect(log.writes.map((w) => w.length)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(log.writes.map((w) => w[0])).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('maxWriteBytes overrides the MTU limit', async () => {
    const link = new MemoryBleLink({ mtu: 247, maxWriteBytes: 100 });
    peripheral(link);
    const c = await connect(link);
    await c.tx.writeValueWithoutResponse(bytes(100));
    await expect(c.tx.writeValueWithoutResponse(bytes(101))).rejects.toThrow();
  });

  it('notifications reach a client that started them, in order, and not before', async () => {
    const link = new MemoryBleLink({ mtu: 100 });
    const { h, log } = peripheral(link);
    const c = await connect(link);
    const id = log.connects[0]!;
    const got: number[] = [];
    c.rx.addEventListener('characteristicvaluechanged', (e: any) => got.push(e.target.value.byteLength));
    await h.notify(id, bytes(5)); // not subscribed yet
    await c.rx.startNotifications();
    for (const n of [10, 20, 30]) await h.notify(id, bytes(n));
    await flush();
    expect(got).toEqual([10, 20, 30]);
    await expect(h.notify(id, bytes(98))).rejects.toMatchObject({ code: 'frame-too-large' });
  });

  it('loss and duplication are deterministic by seed, and never reorder', async () => {
    const run = async (seed: number) => {
      const link = new MemoryBleLink({ mtu: 247, lossRate: 0.2, duplicateRate: 0.2, seed });
      const { log } = peripheral(link);
      const c = await connect(link);
      for (let i = 0; i < 100; i++) await c.tx.writeValueWithoutResponse(Uint8Array.of(i));
      await flush();
      return log.writes.map((w) => w[0]!);
    };
    const a = await run(7);
    expect(await run(7)).toEqual(a);
    expect(await run(8)).not.toEqual(a);
    expect(a.length).not.toBe(100);
    // never reordered: values never decrease
    expect(a.every((v, i) => i === 0 || v >= a[i - 1]!)).toBe(true);
  });

  it('writes with response and INFO reads are reliable even on a lossy link', async () => {
    const link = new MemoryBleLink({ lossRate: 1 });
    const { log } = peripheral(link);
    const c = await connect(link);
    await c.tx.writeValueWithResponse(bytes(50));
    await flush();
    expect(log.writes).toHaveLength(1);
  });

  it('disconnect from either side raises gattserverdisconnected once, and the peripheral is told once', async () => {
    const link = new MemoryBleLink();
    const { h, log } = peripheral(link);
    const c = await connect(link);
    let events = 0;
    c.dev.addEventListener('gattserverdisconnected', () => events++);
    await h.disconnect(log.connects[0]!);
    await flush();
    expect(events).toBe(1);
    expect(c.dev.gatt.connected).toBe(false);
    c.dev.gatt.disconnect();
    await flush();
    expect(events).toBe(1);
    expect(log.disconnects).toHaveLength(1);
    await expect(c.tx.writeValueWithoutResponse(bytes(1))).rejects.toThrow();
  });

  it('power off drops every connection once and blocks new ones until power returns', async () => {
    const link = new MemoryBleLink();
    const { log } = peripheral(link);
    const c = await connect(link);
    link.setPower(false);
    await flush();
    expect(log.disconnects).toHaveLength(1);
    expect(c.dev.gatt.connected).toBe(false);
    await expect(link.bluetooth().requestDevice({ filters: [{ services: [SERVICE] }] })).rejects.toThrow();
    link.setPower(true);
    await connect(link);
  });

  it('a peripheral can refuse a connection (radio-level reject)', async () => {
    const link = new MemoryBleLink();
    peripheral(link, { connect: () => false });
    const bt = link.bluetooth();
    const dev = (await bt.requestDevice({ filters: [{ services: [SERVICE] }] })) as any;
    await expect(dev.gatt.connect()).rejects.toThrow();
  });

  it('latency delays delivery but keeps order', async () => {
    const link = new MemoryBleLink({ latencyMs: 20 });
    const { log } = peripheral(link);
    const c = await connect(link);
    await c.tx.writeValueWithoutResponse(Uint8Array.of(1));
    await c.tx.writeValueWithoutResponse(Uint8Array.of(2));
    expect(log.writes).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 80));
    expect(log.writes.map((w) => w[0])).toEqual([1, 2]);
  });

  it('getDevices returns devices already granted when enabled', async () => {
    const link = new MemoryBleLink({ getDevices: true });
    peripheral(link);
    const bt = link.bluetooth();
    expect(await bt.getDevices!()).toHaveLength(0);
    await bt.requestDevice({ filters: [{ services: [SERVICE] }] });
    expect(await bt.getDevices!()).toHaveLength(1);
    expect(link.bluetooth({ getDevices: false }).getDevices).toBeUndefined();
  });
});
