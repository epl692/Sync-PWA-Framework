/**
 * hubStoreContract(): the reusable contract suite for `HubStore` (spec 005, Principle VIII; research R-10, data-model "StoredPacketSet").
 * Retention is by UTC day shard: a shard expires once it ended before `now - retentionDays`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { ClientRecord, HubSettings, HubStore, ServedSpaceRecord } from '@sync/hub-core';

export interface HubStoreHarness {
  create(): Promise<{
    store: HubStore;
    /** Close and reopen, as after an app restart. For persistent stores this goes through the real medium. */
    reopen(): Promise<HubStore>;
    /** Optional fault injection: leave the store as if the process died halfway through appending a record. */
    tearLastRecord?(): Promise<void>;
    teardown(): Promise<void>;
  }>;
}

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 27, 12, 0, 0);

const settings = (over: Partial<HubSettings> = {}): HubSettings => ({
  displayName: 'Camp hub',
  accessMode: 'open',
  autoSpaces: false,
  maxClients: 7,
  retentionDays: 14,
  storageLimitBytes: 1 << 30,
  perSpaceCapBytes: 1 << 28,
  hubToHub: true,
  keepAwake: false,
  ...over,
});

const bytes = (n: number, v: number) => new Uint8Array(n).fill(v);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

async function ids(store: HubStore, space: string) {
  const out: Array<{ id: string; size: number; receivedAt: number; delivered: number }> = [];
  for await (const x of store.listIds(space)) out.push(x);
  return out;
}

export function hubStoreContract(name: string, harness: HubStoreHarness): void {
  describe(`HubStore contract: ${name}`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      while (cleanups.length) await cleanups.pop()!().catch(() => undefined);
    });
    async function open() {
      const h = await harness.create();
      cleanups.push(h.teardown);
      await h.store.open();
      return h;
    }

    it('addPacket is idempotent by id and returns the stored bytes unchanged', async () => {
      const { store } = await open();
      const a = Uint8Array.from([1, 2, 3, 250]);
      expect(await store.addPacket('S', 'a:1', a, T0)).toBe(true);
      expect(await store.addPacket('S', 'a:1', bytes(9, 9), T0 + 1)).toBe(false);
      const got = await store.getPackets('S', ['a:1', 'missing:1']);
      expect(got).toHaveLength(1);
      expect(same(got[0]!.bytes, a)).toBe(true);
      got[0]!.bytes[0] = 99; // a returned copy never changes what is stored
      expect(same((await store.getPackets('S', ['a:1']))[0]!.bytes, a)).toBe(true);
    });

    it('keeps Spaces separate', async () => {
      const { store } = await open();
      await store.addPacket('S1', 'a:1', bytes(5, 1), T0);
      await store.addPacket('S2', 'a:1', bytes(7, 2), T0);
      expect((await ids(store, 'S1')).map((x) => x.size)).toEqual([5]);
      expect((await ids(store, 'S2')).map((x) => x.size)).toEqual([7]);
    });

    it('listIds reports size, receivedAt and delivered; markDelivered counts peers', async () => {
      const { store } = await open();
      await store.addPacket('S', 'a:1', bytes(10, 1), T0);
      await store.addPacket('S', 'a:2', bytes(20, 2), T0 + 5);
      let l = await ids(store, 'S');
      expect(l.map((x) => [x.id, x.size, x.receivedAt, x.delivered])).toEqual([['a:1', 10, T0, 0], ['a:2', 20, T0 + 5, 0]]);
      await store.markDelivered('S', ['a:1']);
      await store.markDelivered('S', ['a:1', 'a:2', 'unknown:9']);
      l = await ids(store, 'S');
      expect(l.map((x) => x.delivered)).toEqual([2, 1]);
    });

    it('usage totals sizes per Space', async () => {
      const { store } = await open();
      await store.addPacket('S1', 'a:1', bytes(10, 1), T0);
      await store.addPacket('S1', 'a:2', bytes(15, 1), T0);
      await store.addPacket('S2', 'a:1', bytes(30, 1), T0);
      const u = await store.usage();
      expect(u.perSpace).toEqual({ S1: 25, S2: 30 });
      expect(u.total).toBe(55);
    });

    it('persists packets, delivery counts, settings, Spaces, clients and the Hub key across a restart', async () => {
      const h = await open();
      const sp: ServedSpaceRecord = {
        space: 'S',
        name: 'Family',
        source: 'code',
        accessKeys: [{ epoch: 4, publicKey: bytes(32, 7), addedAt: T0 }, { epoch: 3, publicKey: bytes(32, 6), addedAt: T0 - 1, expiresAt: T0 + DAY }],
        accessSecret: bytes(32, 9),
        addedAt: T0,
      };
      const cl: ClientRecord = { device: 'dev1', name: 'Maya', state: 'trusted', strikes: 1, blockedUntil: T0 + 5, lastSeen: T0, spaces: ['S'] };
      await h.store.addPacket('S', 'a:1', bytes(10, 3), T0);
      await h.store.markDelivered('S', ['a:1']);
      await h.store.saveSettings(settings({ displayName: 'Persisted', retentionDays: 30 }));
      await h.store.putSpace(sp);
      await h.store.putClient(cl);
      await h.store.saveHubKey(bytes(32, 5));
      const s2 = await h.reopen();
      expect((await s2.getPackets('S', ['a:1']))[0]!.bytes).toEqual(bytes(10, 3));
      expect((await ids(s2, 'S'))[0]!.delivered).toBe(1);
      expect(await s2.settings()).toEqual(settings({ displayName: 'Persisted', retentionDays: 30 }));
      expect(await s2.spaces()).toEqual([sp]);
      expect(await s2.clients()).toEqual([cl]);
      expect(await s2.loadHubKey()).toEqual(bytes(32, 5));
    });

    it('settings, Spaces and clients can be replaced and deleted', async () => {
      const { store } = await open();
      expect(await store.settings()).toBeUndefined();
      expect(await store.loadHubKey()).toBeUndefined();
      await store.putSpace({ space: 'S', source: 'auto', accessKeys: [], addedAt: T0 });
      await store.putSpace({ space: 'S', source: 'code', accessKeys: [], addedAt: T0 + 1 });
      expect((await store.spaces()).map((s) => s.source)).toEqual(['code']);
      await store.deleteSpace('S');
      expect(await store.spaces()).toEqual([]);
      await store.putClient({ device: 'd', name: 'x', state: 'pending', strikes: 0, lastSeen: T0, spaces: [] });
      await store.putClient({ device: 'd', name: 'x', state: 'trusted', strikes: 0, lastSeen: T0, spaces: [] });
      expect((await store.clients()).map((c) => c.state)).toEqual(['trusted']);
      await store.deleteClient('d');
      expect(await store.clients()).toEqual([]);
    });

    it('deleteSpacePackets removes only that Space', async () => {
      const { store } = await open();
      await store.addPacket('S1', 'a:1', bytes(10, 1), T0);
      await store.addPacket('S2', 'a:1', bytes(10, 1), T0);
      await store.deleteSpacePackets('S1');
      expect(await ids(store, 'S1')).toEqual([]);
      expect(await ids(store, 'S2')).toHaveLength(1);
      expect((await store.usage()).perSpace).toEqual({ S2: 10 });
    });

    it('enforce deletes whole expired day shards and keeps the rest', async () => {
      const { store } = await open();
      await store.addPacket('S', 'old:1', bytes(10, 1), T0 - 20 * DAY);
      await store.addPacket('S', 'old:2', bytes(10, 1), T0 - 20 * DAY + 1000);
      await store.addPacket('S', 'new:1', bytes(10, 1), T0 - 3 * DAY);
      const r = await store.enforce({ now: T0, retentionDays: 14, limitBytes: 1 << 30 });
      expect(r).toEqual({ expired: 2, evictedDelivered: 0, evictedUndelivered: 0 });
      expect((await ids(store, 'S')).map((x) => x.id)).toEqual(['new:1']);
      // changing the retention takes effect on the next enforcement
      const r2 = await store.enforce({ now: T0, retentionDays: 1, limitBytes: 1 << 30 });
      expect(r2.expired).toBe(1);
      expect(await ids(store, 'S')).toEqual([]);
    });

    it('under storage pressure evicts delivered packets (oldest first) before undelivered ones', async () => {
      const { store } = await open();
      // oldest to newest: u1 (undelivered), d1 (delivered), u2, d2
      await store.addPacket('S', 'u1:1', bytes(100, 1), T0 - 4 * DAY);
      await store.addPacket('S', 'd1:1', bytes(100, 1), T0 - 3 * DAY);
      await store.addPacket('S', 'u2:1', bytes(100, 1), T0 - 2 * DAY);
      await store.addPacket('S', 'd2:1', bytes(100, 1), T0 - 1 * DAY);
      await store.markDelivered('S', ['d1:1', 'd2:1']);
      let r = await store.enforce({ now: T0, retentionDays: 365, limitBytes: 300 });
      expect(r).toEqual({ expired: 0, evictedDelivered: 1, evictedUndelivered: 0 });
      expect((await ids(store, 'S')).map((x) => x.id)).toEqual(['u1:1', 'u2:1', 'd2:1']);
      r = await store.enforce({ now: T0, retentionDays: 365, limitBytes: 100 });
      // d2 goes first (the only delivered one left), then the OLDEST undelivered
      expect(r).toEqual({ expired: 0, evictedDelivered: 1, evictedUndelivered: 1 });
      expect((await ids(store, 'S')).map((x) => x.id)).toEqual(['u2:1']);
      expect((await store.usage()).total).toBe(100);
    });

    it('enforce does nothing when under every limit', async () => {
      const { store } = await open();
      await store.addPacket('S', 'a:1', bytes(10, 1), T0);
      expect(await store.enforce({ now: T0, retentionDays: 14, limitBytes: 1000 })).toEqual({ expired: 0, evictedDelivered: 0, evictedUndelivered: 0 });
    });

    it('a torn last record is discarded on reopen and earlier records are intact', async () => {
      const h = await open();
      if (!h.tearLastRecord) return;
      await h.store.addPacket('S', 'a:1', bytes(50, 1), T0);
      await h.store.addPacket('S', 'a:2', bytes(50, 2), T0 + 1);
      await h.tearLastRecord();
      const s2 = await h.reopen();
      const got = await ids(s2, 'S');
      expect(got.map((x) => x.id)).toContain('a:1');
      expect(await s2.getPackets('S', ['a:1'])).toHaveLength(1);
      // whatever survived is complete: never a partial packet
      for (const g of got) expect((await s2.getPackets('S', [g.id]))[0]!.bytes.length).toBe(g.size);
      // and the store keeps working
      expect(await s2.addPacket('S', 'a:3', bytes(5, 3), T0 + 2)).toBe(true);
    });
  });
}
