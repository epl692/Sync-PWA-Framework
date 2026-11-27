// Spec 005 T082 (US4): the Hub keeps packets 14 days by default, drops whole expired day shards, evicts delivered packets first,
// and warns the owner before undelivered ones go.
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryBleLink, MockBleBridge, RawClient, createFakeTimers, createSpaceAccess, memberProofs, remoteEnvelope, waitFor } from '@sync/testkit';
import { b64urlEncode, encodeMessage } from '@sync/core';
import { createHub, createMemoryStore, createSegmentStore, createMemoryFs, type HubEvent, type HubStore } from '../src';

const DAY = 86_400_000;
const hubs: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (hubs.length) await hubs.pop()!().catch(() => undefined);
});

async function setup(o: { store?: HubStore; settings?: Parameters<typeof createHub>[0]['settings'] } = {}) {
  const clock = createFakeTimers();
  const link = new MemoryBleLink({ mtu: 185 });
  const bridge = new MockBleBridge(link);
  const store = o.store ?? createMemoryStore();
  const hub = await createHub({ bridge, store, now: clock.now, timers: clock.timers, ...(o.settings ? { settings: o.settings } : {}) });
  await hub.start();
  const access = await createSpaceAccess();
  await hub.addServeCode(access.serveCode);
  hubs.push(async () => void (await hub.stop(), await bridge.close()));
  const events: HubEvent[] = [];
  hub.on((e) => events.push(e));
  const client = await RawClient.open(link);
  await client.handshake();
  await client.auth(await memberProofs([access], 'feeder'));
  await client.sendCore(encodeMessage({ t: 'hello', protocol: { min: 1, max: 1 }, device: 'D', spaces: [access.space], relay: true }));
  /** Send a packet to the Hub as a member would. */
  const feed = async (author: string, seq: number, size = 200) => {
    const e = await remoteEnvelope({ obj: `o${seq}`, op: 'create', type: 't', fields: { pad: 'x'.repeat(size) } }, { author, seq, space: access.space });
    await client.sendCore(encodeMessage({ t: 'packets', space: access.space, items: [b64urlEncode(e.raw)] }));
    await waitFor(async () => (await store.getPackets(access.space, [`${author}:${seq}`])).length === 1, 3000, 'packet to be stored');
    return `${author}:${seq}`;
  };
  return { clock, hub, store, events, feed, space: access.space };
}

const hasPacket = async (store: HubStore, space: string, id: string) => (await store.getPackets(space, [id])).length === 1;

describe('retention', () => {
  it('defaults to 14 days', async () => {
    const s = await setup();
    expect(s.hub.settings().retentionDays).toBe(14);
    const id = await s.feed('AUTH', 1);
    await s.clock.advance(13 * DAY);
    await s.hub.enforceNow();
    expect(await hasPacket(s.store, s.space, id)).toBe(true);
    await s.clock.advance(3 * DAY);
    await s.hub.enforceNow();
    expect(await hasPacket(s.store, s.space, id)).toBe(false);
  });

  it('expired packets are removed from the store and the relay after the retention period', async () => {
    const s = await setup({ settings: { retentionDays: 3 } });
    const id = await s.feed('AUTH', 1);
    expect(await hasPacket(s.store, s.space, id)).toBe(true);
    expect(s.hub.relay.stats.packets).toBe(1);
    await s.clock.advance(2 * DAY);
    await s.hub.enforceNow();
    expect(await hasPacket(s.store, s.space, id)).toBe(true); // still within 3 days
    await s.clock.advance(3 * DAY);
    await s.hub.enforceNow(); // (the hourly run may already have done it)
    expect(await hasPacket(s.store, s.space, id)).toBe(false);
    expect(s.hub.relay.stats.packets).toBe(0);
  });

  it('changing the retention period takes effect straight away', async () => {
    const s = await setup({ settings: { retentionDays: 30 } });
    const id = await s.feed('AUTH', 1);
    await new Promise((r) => setTimeout(r, 10));
    await s.clock.advance(5 * DAY);
    await s.hub.updateSettings({ retentionDays: 2 });
    await new Promise((r) => setTimeout(r, 30));
    expect(await hasPacket(s.store, s.space, id)).toBe(false);
  });

  it('runs by itself every hour', async () => {
    const s = await setup({ settings: { retentionDays: 1 } });
    const id = await s.feed('AUTH', 1);
    await new Promise((r) => setTimeout(r, 10));
    await s.clock.advance(3 * DAY);
    await new Promise((r) => setTimeout(r, 30));
    expect(await hasPacket(s.store, s.space, id)).toBe(false);
  });

  it('under storage pressure delivered packets go first and the owner is warned before an undelivered one is lost', async () => {
    const s = await setup({ settings: { storageLimitBytes: 5_000, perSpaceCapBytes: 5_000 } });
    const ids: string[] = [];
    for (let i = 1; i <= 8; i++) ids.push(await s.feed('AUTH', i, 400));
    await new Promise((r) => setTimeout(r, 20));
    await s.store.markDelivered(s.space, [ids[0]!, ids[1]!]);
    await s.hub.updateSettings({ storageLimitBytes: 3_000, perSpaceCapBytes: 3_000 });
    await new Promise((r) => setTimeout(r, 50));
    const used = (await s.store.usage()).total;
    expect(used).toBeLessThanOrEqual(3_000);
    expect(await hasPacket(s.store, s.space, ids[0]!)).toBe(false); // delivered: evicted first
    expect(await hasPacket(s.store, s.space, ids[1]!)).toBe(false);
    expect(await hasPacket(s.store, s.space, ids[7]!)).toBe(true);
    expect(s.events.some((e) => e.type === 'storage-warning' && e.level === 'evicting-undelivered')).toBe(true);
  });

  it('warns once when storage nears its limit', async () => {
    const s = await setup({ settings: { storageLimitBytes: 4_000, perSpaceCapBytes: 4_000 } });
    for (let i = 1; i <= 7; i++) await s.feed('AUTH', i, 400);
    await new Promise((r) => setTimeout(r, 20));
    await s.hub.enforceNow();
    await s.hub.enforceNow();
    expect(s.events.filter((e) => e.type === 'storage-warning' && e.level === 'near-limit')).toHaveLength(1);
  });

  it('works the same on the file-backed store (and survives a restart with the packets still there)', async () => {
    const fs = createMemoryFs();
    const s = await setup({ store: createSegmentStore(fs), settings: { retentionDays: 3 } });
    const id = await s.feed('AUTH', 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(await hasPacket(s.store, s.space, id)).toBe(true);
    await s.clock.advance(5 * DAY);
    await s.hub.enforceNow();
    expect([...fs.files.keys()].filter((k) => k.endsWith('.seg'))).toEqual([]);
  });
});

