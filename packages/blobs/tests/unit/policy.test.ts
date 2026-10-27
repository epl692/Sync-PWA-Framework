// T074: pins are device-local and persistent, replicas protect blobs, and usage() reports what is held.
import { describe, expect, it } from 'vitest';
import { createBlobs, createMemoryBlobStorage } from '../../src';
import { storedBytes } from '../../src/policy/policy';
import { SPACE, pattern, plainPeers, testBlobs, vectorProvider } from '../helpers';
import { createTestCore, readPacketRecords } from '@sync/testkit';

describe('pins', () => {
  it('persist across a restart and show in the status', async () => {
    const t = await testBlobs();
    const ref = await t.blobs.attach(new Blob([pattern(1000) as BlobPart]), { space: SPACE, obj: 'o1' });
    await t.blobs.pin(ref);
    expect(t.blobs.observe(ref).get().pinned).toBe(true);
    await t.blobs.close();
    const tc = await createTestCore();
    const again = await createBlobs({ core: tc.core, keyProvider: await vectorProvider(), storage: t.storage });
    expect(again.observe(ref).get()).toMatchObject({ state: 'missing' }); // synchronous first answer ...
    await new Promise((r) => setTimeout(r, 20));
    expect(again.observe(ref).get()).toMatchObject({ state: 'available', pinned: true }); // ... then what is stored
    await again.unpin(ref);
    expect((await t.storage.getBlob(ref.id))!.pinned).toBe(false);
  });

  it('are never sent to a peer or written as a packet', async () => {
    const t = await plainPeers(['a', 'b']);
    const ref = await t.attach('a', pattern(5000));
    await new Promise((r) => setTimeout(r, 100));
    const lane = t.faults.sent.length;
    const packets = (await readPacketRecords(t.p.peers.a!.storage)).length;
    await t.engines.a!.pin(ref);
    await t.engines.a!.unpin(ref);
    await new Promise((r) => setTimeout(r, 100));
    expect(t.faults.sent.length).toBe(lane);
    expect((await readPacketRecords(t.p.peers.a!.storage)).length).toBe(packets);
    for (const s of t.faults.sent) expect(new TextDecoder('latin1').decode(s.bytes).toLowerCase().includes('pinned')).toBe(false);
    await t.close();
  });

  it('pinning a blob that is not here fetches it first', async () => {
    const t = await plainPeers(['a', 'b']);
    const ref = await t.attach('a', pattern(5000));
    await t.engines.b!.pin(ref);
    expect(t.engines.b!.observe(ref).get()).toMatchObject({ state: 'available', pinned: true });
    await t.close();
  });

  it('refuses something that is not a reference', async () => {
    const t = await testBlobs();
    await expect(t.blobs.pin({ $blob: 1 } as never)).rejects.toBeInstanceOf(TypeError);
  });
});

describe('usage', () => {
  it('reports bytes held, complete blobs, pinned bytes and bytes with too few confirmed copies', async () => {
    const t = await testBlobs();
    const a = await t.blobs.attach(new Blob([pattern(300_000, 1) as BlobPart]), { space: SPACE, obj: 'o1' });
    await t.blobs.attach(new Blob([pattern(100_000, 2) as BlobPart]), { space: SPACE, obj: 'o2' });
    await t.blobs.pin(a);
    const rec = (await t.storage.getBlob(a.id))!;
    await t.storage.putBlob({ ...rec, replicas: ['relay:1'] }); // a is confirmed elsewhere, the other blob is not
    const u = await t.blobs.usage();
    expect(u.blobs).toBe(2);
    expect(u.usedBytes).toBe(storedBytes(300_000) + storedBytes(100_000));
    expect(u.pinnedBytes).toBe(storedBytes(300_000));
    expect(u.unreplicatedBytes).toBe(storedBytes(100_000));
  });

  it('does not count an evicted or partial blob as held', async () => {
    const t = await testBlobs();
    const a = await t.blobs.attach(new Blob([pattern(1000) as BlobPart]), { space: SPACE, obj: 'o1' });
    const rec = (await t.storage.getBlob(a.id))!;
    await t.storage.putBlob({ ...rec, replicas: ['relay:1'] });
    await t.blobs.evict({ targetBytes: 0 });
    expect(await t.blobs.usage()).toEqual({ usedBytes: 0, blobs: 0, pinnedBytes: 0, unreplicatedBytes: 0 });
    void createMemoryBlobStorage;
  });
});
