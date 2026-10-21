// T083 (Story 5): compaction folds old history into snapshots without changing state, and peers bootstrap from them.
import { describe, expect, it } from 'vitest';
import { createMemoryStorage, type StorageAdapter, type StorageTx, type StoreName } from '@sync/core';
import { createPeers, createTestCore, readPacketRecords, waitFor } from '@sync/testkit';

const DAY = 24 * 60 * 60 * 1000;

async function history(t: Awaited<ReturnType<typeof createTestCore>>, objects = 5, edits = 20) {
  const ids: string[] = [];
  for (let i = 0; i < objects; i++) ids.push((await t.core.create('s1', 'item', { i, n: 0 })).id);
  for (let e = 1; e <= edits; e++) {
    t.clock.advance(1000);
    for (const id of ids) await t.core.update(id, { n: e });
  }
  return ids;
}

describe('compaction', () => {
  it('leaves current state identical and removes only packets older than the window (scenario 2)', async () => {
    const t = await createTestCore({ retentionWindowMs: 30 * DAY });
    const ids = await history(t);
    await t.core.remove(ids[0]!);
    const hash = await t.core.stateHash('s1');
    const total = (await readPacketRecords(t.storage)).length;

    t.clock.advance(10 * DAY);
    expect(await t.core.compact()).toMatchObject({ packetsRemoved: 0 }); // nothing is old enough yet

    t.clock.advance(25 * DAY); // now everything so far is older than 30 days
    t.clock.advance(1000);
    await t.core.update(ids[1]!, { n: 'fresh' }); // a recent packet that must survive
    const hashBefore = await t.core.stateHash('s1');
    const r = await t.core.compact();
    expect(r.packetsRemoved).toBe(total);
    expect(r.bytesFreed).toBeGreaterThan(0);
    expect(await t.core.stateHash('s1')).toBe(hashBefore);
    expect((await readPacketRecords(t.storage)).map((p) => p.op)).toEqual(['update']); // only the fresh one is left
    expect(hash).not.toBe(hashBefore);
    expect(await t.core.get(ids[0]!)).toBeUndefined(); // tombstone survived compaction
    expect((await (await t.reopen()).get(ids[1]!))!.fields.n).toBe('fresh');
  });

  it('is idempotent', async () => {
    const t = await createTestCore({ retentionWindowMs: DAY });
    await history(t, 3, 5);
    t.clock.advance(5 * DAY);
    const first = await t.core.compact();
    expect(first.packetsRemoved).toBeGreaterThan(0);
    expect(await t.core.compact()).toMatchObject({ packetsRemoved: 0 });
  });

  it('lets a fresh peer bootstrap from a snapshot and converge (scenario 1 of bootstrap)', async () => {
    const p = await createPeers(['a', 'fresh'], { spaces: ['s1'], retentionWindowMs: 30 * DAY });
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await p.core('a').create('s1', 'item', { i })).id);
    p.peers.a!.clock.advance(1000);
    await p.core('a').update(ids[0]!, { extra: true });
    await p.core('a').remove(ids[5]!);
    p.peers.a!.clock.advance(40 * DAY);
    expect((await p.core('a').compact()).packetsRemoved).toBeGreaterThan(0);
    expect(await readPacketRecords(p.peers.a!.storage)).toEqual([]);

    p.link('a', 'fresh');
    await p.converged('s1');
    expect((await p.core('fresh').query({ type: 'item' }).once()).length).toBe(5);
    expect((await p.core('fresh').get(ids[0]!))!.fields.extra).toBe(true);
    expect(await p.core('fresh').get(ids[5]!)).toBeUndefined();
  });

  it('resyncs a peer that was offline longer than the window from a snapshot plus newer packets (scenario 3)', async () => {
    const p = await createPeers(['a', 'b'], { spaces: ['s1'], retentionWindowMs: 30 * DAY });
    p.link('a', 'b');
    const o = await p.core('a').create('s1', 'item', { v: 1 });
    await p.converged('s1');
    p.net.sever('a', 'b');
    await new Promise((r) => setTimeout(r, 20));

    p.peers.a!.clock.advance(1000);
    await p.core('a').update(o.id, { v: 2, old: 'yes' });
    const second = await p.core('a').create('s1', 'item', { v: 'second' });
    p.peers.a!.clock.advance(45 * DAY);
    await p.core('a').compact();
    p.peers.a!.clock.advance(1000);
    await p.core('a').update(second.id, { v: 'after compaction' }); // newer than the snapshot

    p.net.restore('a', 'b');
    await p.converged('s1');
    expect((await p.core('b').get(o.id))!.fields).toEqual({ v: 2, old: 'yes' });
    expect((await p.core('b').get(second.id))!.fields.v).toBe('after compaction');
  });

  it('lets a bootstrapped peer pass the snapshot on to a third peer', async () => {
    const p = await createPeers(['a', 'b', 'c'], { spaces: ['s1'], retentionWindowMs: DAY });
    for (let i = 0; i < 4; i++) await p.core('a').create('s1', 'item', { i });
    p.peers.a!.clock.advance(5 * DAY);
    await p.core('a').compact();
    p.link('a', 'b');
    await p.converged('s1', ['a', 'b']);
    p.net.sever('a', 'b');
    p.link('b', 'c');
    await p.converged('s1', ['b', 'c']);
    expect(await p.core('c').query({ type: 'item' }).once()).toHaveLength(4);
  });

  it('survives a crash between writing the snapshot and deleting packets', async () => {
    const inner = createMemoryStorage();
    const armed = { on: false };
    const storage = {
      ...inner,
      close: () => inner.close(),
      transaction: (stores: readonly StoreName[], mode: 'readonly' | 'readwrite', fn: (tx: StorageTx) => Promise<unknown>) =>
        inner.transaction(stores, mode, (tx) =>
          fn({
            ...tx,
            get: tx.get.bind(tx),
            put: tx.put.bind(tx),
            scan: tx.scan.bind(tx),
            delete: async (s: StoreName, k: string) => {
              if (armed.on && s === 'packets') throw new Error('simulated crash');
              return tx.delete(s, k);
            },
          }),
        ),
    } as unknown as StorageAdapter;
    const t = await createTestCore({ storage, retentionWindowMs: DAY });
    await history(t, 3, 4);
    t.clock.advance(5 * DAY);
    const hash = await t.core.stateHash('s1');
    armed.on = true;
    await expect(t.core.compact()).rejects.toThrow('simulated crash');
    armed.on = false;
    expect(await t.core.stateHash('s1')).toBe(hash); // nothing lost
    const retry = await t.core.compact();
    expect(retry.packetsRemoved).toBeGreaterThan(0);
    expect(await t.core.stateHash('s1')).toBe(hash);
  });

  it('compacts early when storage reports pressure', async () => {
    const t = await createTestCore({ storage: createMemoryStorage({ quotaBytes: 100_000 }), retentionWindowMs: DAY });
    await history(t, 3, 5);
    t.clock.advance(5 * DAY);
    const before = (await readPacketRecords(t.storage)).length;
    // a write that does not fit raises storage:pressure, which compacts old history right away
    await expect(t.core.create('s1', 'blob', { data: 'x'.repeat(150_000) })).rejects.toMatchObject({ code: 'storage-quota' });
    await waitFor(async () => (await readPacketRecords(t.storage)).length < before, 3000, 'compaction after pressure');
  });
});
