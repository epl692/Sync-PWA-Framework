// Spec 005 T081 (US4): the segment store passes the HubStore contract on memory and on real files, and survives crashes.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hubStoreContract } from '@sync/testkit';
import { createMemoryFs } from '../src/store/fsPort';
import { createNodeFs } from '../src/store/nodeFs';
import { SegmentFormatError, createSegmentStore, crc32 } from '../src/store/segmentStore';

hubStoreContract('segment store on memory fs', {
  async create() {
    const fs = createMemoryFs();
    let store = createSegmentStore(fs);
    return {
      get store() {
        return store;
      },
      reopen: async () => (await store.close(), (store = createSegmentStore(fs)), await store.open(), store),
      tearLastRecord: async () => {
        const last = [...fs.files.keys()].filter((k) => k.endsWith('.seg')).sort().at(-1)!;
        fs.tear(last, 7);
      },
      teardown: async () => store.close(),
    } as never;
  },
});

hubStoreContract('segment store on real files', {
  async create() {
    const dir = await mkdtemp(join(tmpdir(), 'hub-store-'));
    const fs = createNodeFs(dir);
    let store = createSegmentStore(fs);
    return {
      get store() {
        return store;
      },
      reopen: async () => (await store.close(), (store = createSegmentStore(fs)), await store.open(), store),
      teardown: async () => (await store.close(), void (await rm(dir, { recursive: true, force: true }).catch(() => undefined))),
    } as never;
  },
});

describe('segment store specifics', () => {
  const T0 = Date.UTC(2026, 10, 27, 12);
  const bytes = (n: number, v: number) => new Uint8Array(n).fill(v);

  it('crc32 matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('a torn last record is discarded on reopen and nothing before it is lost; appending then works', async () => {
    const fs = createMemoryFs();
    let s = createSegmentStore(fs);
    await s.open();
    for (let i = 0; i < 5; i++) await s.addPacket('S', `a:${i}`, bytes(40, i), T0 + i);
    const path = [...fs.files.keys()].find((k) => k.endsWith('.seg'))!;
    fs.tear(path, 20); // the last record is cut in the middle
    s = createSegmentStore(fs);
    await s.open();
    const ids: string[] = [];
    for await (const x of s.listIds('S')) ids.push(x.id);
    expect(ids).toEqual(['a:0', 'a:1', 'a:2', 'a:3']);
    expect(await s.addPacket('S', 'a:9', bytes(5, 9), T0 + 10)).toBe(true);
    s = createSegmentStore(fs);
    await s.open();
    expect((await s.getPackets('S', ['a:3', 'a:9'])).map((p) => p.bytes.length)).toEqual([40, 5]);
  });

  it('a corrupted record (flipped byte) ends the valid prefix there instead of serving bad bytes', async () => {
    const fs = createMemoryFs();
    let s = createSegmentStore(fs);
    await s.open();
    for (let i = 0; i < 4; i++) await s.addPacket('S', `a:${i}`, bytes(30, i + 1), T0);
    const path = [...fs.files.keys()].find((k) => k.endsWith('.seg'))!;
    const raw = fs.files.get(path)!;
    raw[raw.length - 60] ^= 0xff; // inside the third record
    s = createSegmentStore(fs);
    await s.open();
    const ids: string[] = [];
    for await (const x of s.listIds('S')) ids.push(x.id);
    expect(ids.length).toBeLessThan(4);
    for (const p of await s.getPackets('S', ids)) expect(p.bytes.every((b) => b === p.bytes[0])).toBe(true);
  });

  it('an unknown segment version is refused, not rewritten', async () => {
    const fs = createMemoryFs();
    let s = createSegmentStore(fs);
    await s.open();
    await s.addPacket('S', 'a:1', bytes(10, 1), T0);
    const path = [...fs.files.keys()].find((k) => k.endsWith('.seg'))!;
    const raw = fs.files.get(path)!;
    raw[5] = 9; // version 9
    const before = raw.slice();
    s = createSegmentStore(fs);
    await expect(s.open()).rejects.toBeInstanceOf(SegmentFormatError);
    expect(fs.files.get(path)).toEqual(before);
  });

  it('shards by UTC day and names files predictably', async () => {
    const fs = createMemoryFs();
    const s = createSegmentStore(fs);
    await s.open();
    await s.addPacket('S', 'a:1', bytes(5, 1), Date.UTC(2026, 0, 2, 23, 59));
    await s.addPacket('S', 'a:2', bytes(5, 2), Date.UTC(2026, 0, 3, 0, 1));
    expect([...fs.files.keys()].filter((k) => k.endsWith('.seg')).sort()).toEqual(['packets/S/20260102.seg', 'packets/S/20260103.seg']);
  });

  it('eviction rewrites the shard so offsets stay right and later reads still work', async () => {
    const fs = createMemoryFs();
    let s = createSegmentStore(fs);
    await s.open();
    for (let i = 0; i < 6; i++) await s.addPacket('S', `a:${i}`, bytes(100, i + 1), T0 + i);
    await s.markDelivered('S', ['a:0', 'a:2']);
    await s.enforce({ now: T0 + 1000, retentionDays: 365, limitBytes: 400 });
    const ids: string[] = [];
    for await (const x of s.listIds('S')) ids.push(x.id);
    expect(ids).toEqual(['a:1', 'a:3', 'a:4', 'a:5']);
    expect((await s.getPackets('S', ['a:5']))[0]!.bytes).toEqual(bytes(100, 6));
    s = createSegmentStore(fs); // and it all survives a restart
    await s.open();
    expect((await s.getPackets('S', ['a:1', 'a:4'])).map((p) => p.bytes[0])).toEqual([2, 5]);
  });

  it('delivery counts of evicted packets are dropped from the log', async () => {
    const fs = createMemoryFs();
    const s = createSegmentStore(fs);
    await s.open();
    await s.addPacket('S', 'a:1', bytes(100, 1), T0);
    await s.addPacket('S', 'a:2', bytes(100, 2), T0 + 1);
    await s.markDelivered('S', ['a:1']);
    await s.enforce({ now: T0 + 1000, retentionDays: 365, limitBytes: 100 });
    expect(fs.files.has('packets/S/delivered.log')).toBe(false);
  });

  it('survives many packets across restarts without changing what it returns', async () => {
    const fs = createMemoryFs();
    let s = createSegmentStore(fs);
    await s.open();
    const want = new Map<string, Uint8Array>();
    for (let i = 0; i < 200; i++) {
      const b = Uint8Array.from({ length: 1 + (i % 50) }, (_, j) => (i + j) & 255);
      want.set(`x:${i}`, b);
      await s.addPacket(`S${i % 3}`, `x:${i}`, b, T0 + i * 3_600_000);
      if (i % 40 === 39) (s = createSegmentStore(fs), await s.open());
    }
    for (const sp of ['S0', 'S1', 'S2']) for await (const x of s.listIds(sp)) expect((await s.getPackets(sp, [x.id]))[0]!.bytes).toEqual(want.get(x.id));
  });
});
