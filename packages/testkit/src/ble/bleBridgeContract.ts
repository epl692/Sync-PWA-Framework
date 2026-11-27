/**
 * bleBridgeContract(): the reusable contract suite for `BleBridge` implementations (spec 005, Principle VIII;
 * specs/005-bluetooth-transport/contracts/hub-ble-bridge.md "Required behavior"). Real bridges run it against a real central
 * through a driver; the mock runs it against the simulator.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { AdvertisingOptions, BleBridge, BleConnId } from '@sync/hub-core';

/** A central that connects to the bridge under test (a phone's browser, or the simulator). */
export interface CentralDriver {
  /** Read INFO. */
  readInfo(): Promise<Uint8Array>;
  /** Connect and subscribe to notifications. Rejects if the bridge refuses. */
  connect(): Promise<void>;
  /** One GATT write without response. */
  write(frame: Uint8Array): Promise<void>;
  onNotify(cb: (frame: Uint8Array) => void): void;
  disconnect(): Promise<void>;
  /** The ATT MTU this central negotiates. */
  mtu: number;
}

export interface BleBridgeHarness {
  create(): Promise<{
    bridge: BleBridge;
    newCentral(): Promise<CentralDriver>;
    /** Switch the adapter off and on, if the harness can. */
    setBluetooth?(on: boolean): Promise<void>;
    teardown(): Promise<void>;
  }>;
}

export const LINK_UUIDS = {
  serviceUuid: 'a89242f7-786e-4bf2-9b00-b028957dc0eb',
  infoUuid: 'c71b9f0e-0fc5-48bd-9bff-6428700a9eea',
  txUuid: '9ec66df3-0a3e-4c6a-a381-37405b5ac00c',
  rxUuid: '16d9aa8a-90ef-407b-a339-80534210840d',
};

const adv = (over: Partial<AdvertisingOptions> = {}): AdvertisingOptions => ({
  ...LINK_UUIDS,
  name: 'Test Hub',
  info: new TextEncoder().encode('{"v":[1,1],"slots":2}'),
  maxConnections: 2,
  ...over,
});

async function until<T>(fn: () => T | undefined | false, timeoutMs = 3000, label = 'condition'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export function bleBridgeContract(name: string, harness: BleBridgeHarness): void {
  describe(`BleBridge contract: ${name}`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      while (cleanups.length) await cleanups.pop()!().catch(() => undefined);
    });

    async function setup() {
      const h = await harness.create();
      cleanups.push(h.teardown);
      const events = {
        connected: [] as Array<{ conn: BleConnId; mtu: number }>,
        writes: [] as Array<{ conn: BleConnId; frame: Uint8Array }>,
        disconnected: [] as BleConnId[],
        states: [] as string[],
      };
      h.bridge.on('connected', (conn, info) => events.connected.push({ conn, mtu: info.mtu }));
      h.bridge.on('write', (conn, frame) => events.writes.push({ conn, frame: frame.slice() }));
      h.bridge.on('disconnected', (conn) => events.disconnected.push(conn));
      h.bridge.on('state', (s) => events.states.push(s));
      return { ...h, events };
    }

    it('1. support() never throws and reports coded reasons', async () => {
      const { bridge } = await setup();
      const s = await bridge.support();
      for (const part of [s.peripheral, s.central]) {
        expect(typeof part.ok).toBe('boolean');
        if (!part.ok) {
          expect(part.reason.length).toBeGreaterThan(0);
          expect(['no-adapter', 'bluetooth-off', 'permission-denied', 'peripheral-role-unsupported', 'os-too-old', 'bridge-failed']).toContain(part.code);
        }
      }
    });

    it('2. write events preserve GATT write boundaries and order, unmerged and unsplit', async () => {
      const { bridge, newCentral, events } = await setup();
      await bridge.startAdvertising(adv());
      const c = await newCentral();
      await c.connect();
      const sizes = Array.from({ length: 20 }, (_, i) => i + 1);
      for (const n of sizes) await c.write(new Uint8Array(n).fill(n));
      await until(() => events.writes.length >= sizes.length, 3000, 'all writes');
      expect(events.writes.map((w) => w.frame.length)).toEqual(sizes);
      expect(events.writes.map((w) => w.frame[0])).toEqual(sizes);
    });

    it('3. notify preserves order, rejects frames above mtu - 3, and rejects once the connection is gone', async () => {
      const { bridge, newCentral, events } = await setup();
      await bridge.startAdvertising(adv());
      const c = await newCentral();
      const got: number[] = [];
      c.onNotify((f) => got.push(f.length));
      await c.connect();
      const { conn, mtu } = await until(() => events.connected[0], 3000, 'connected event');
      for (const n of [1, 5, 10, 20]) await bridge.notify(conn, new Uint8Array(n).fill(n));
      await until(() => got.length >= 4, 3000, 'notifications');
      expect(got).toEqual([1, 5, 10, 20]);
      await expect(bridge.notify(conn, new Uint8Array(mtu - 2))).rejects.toMatchObject({ code: 'frame-too-large' });
      await bridge.notify(conn, new Uint8Array(mtu - 3));
      await c.disconnect();
      await until(() => events.disconnected.length >= 1, 3000, 'disconnected');
      await expect(bridge.notify(conn, new Uint8Array(1))).rejects.toMatchObject({ code: 'not-connected' });
    });

    it('4. accepts at least maxConnections and announces every accepted connection', async () => {
      const { bridge, newCentral, events } = await setup();
      await bridge.startAdvertising(adv({ maxConnections: 2 }));
      const results = await Promise.allSettled(
        [0, 1, 2, 3].map(async () => {
          const c = await newCentral();
          await c.connect();
        }),
      );
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      expect(ok).toBeGreaterThanOrEqual(2);
      await until(() => events.connected.length >= ok, 3000, 'connected events');
      expect(events.connected.length).toBe(ok); // never an unannounced connection
    });

    it('5. disconnected is emitted exactly once per connection', async () => {
      const { bridge, newCentral, events } = await setup();
      await bridge.startAdvertising(adv());
      const c = await newCentral();
      await c.connect();
      const { conn } = await until(() => events.connected[0], 3000, 'connected');
      await bridge.disconnect(conn);
      await until(() => events.disconnected.length >= 1, 3000, 'disconnected');
      await bridge.disconnect(conn).catch(() => undefined);
      await c.disconnect().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 50));
      expect(events.disconnected.filter((x) => x === conn)).toHaveLength(1);
    });

    it('6. after Bluetooth turns off and on the bridge re-advertises by itself and reports ready', async () => {
      const { bridge, newCentral, events, setBluetooth } = await setup();
      if (!setBluetooth) return;
      await bridge.startAdvertising(adv());
      const c = await newCentral();
      await c.connect();
      await until(() => events.connected[0], 3000, 'connected');
      await setBluetooth(false);
      await until(() => events.states.includes('bluetooth-off'), 3000, 'bluetooth-off state');
      await until(() => events.disconnected.length >= 1, 3000, 'disconnected on power off');
      await setBluetooth(true);
      await until(() => events.states.at(-1) === 'ready', 3000, 'ready state');
      const c2 = await newCentral();
      await c2.connect();
      expect(events.disconnected).toHaveLength(1);
    });

    it('7. setInfo takes effect for the next INFO read', async () => {
      const { bridge, newCentral } = await setup();
      await bridge.startAdvertising(adv());
      const c = await newCentral();
      expect(new TextDecoder().decode(await c.readInfo())).toContain('"slots":2');
      await bridge.setInfo(new TextEncoder().encode('{"v":[1,1],"slots":0,"full":true}'));
      expect(new TextDecoder().decode(await c.readInfo())).toContain('"full":true');
    });

    it('8. close() releases the radio: nothing can connect afterwards', async () => {
      const { bridge, newCentral } = await setup();
      await bridge.startAdvertising(adv());
      await bridge.close();
      const c = await newCentral().catch(() => undefined);
      if (c) await expect(c.connect()).rejects.toBeDefined();
    });
  });
}
