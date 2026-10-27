// T068 (US3, FR-007): the same content in the same scope and epoch is stored and transferred once.
import { describe, expect, it } from 'vitest';
import { createBlobPeers, waitFor } from '@sync/testkit';
import { CHUNK_BYTES, createBlobs, createMemoryBlobStorage } from '../../src';
import { pattern, plainPeers } from '../helpers';

describe('deduplication', () => {
  it('keeps one stored copy for two objects and transfers it once to another device', async () => {
    const t = await plainPeers(['a', 'b']);
    const bytes = pattern(CHUNK_BYTES * 3 + 1, 5);
    const r1 = await t.attach('a', bytes, 'o1');
    const used = await t.storages.a!.usedBytes();
    const r2 = await t.attach('a', bytes, 'o2');
    expect(r2.id).toBe(r1.id);
    expect(await t.storages.a!.usedBytes()).toBe(used);
    const meta = await t.storages.a!.getMeta<Record<string, number>>('partials');
    expect(meta ?? {}).toEqual({}); // the duplicate attach left no partial behind

    await Promise.all([t.engines.b!.request(r1), t.engines.b!.request(r2)]);
    expect(t.faults.count('chunk', 'a')).toBe(4); // 3 full chunks and a 1-byte tail: once each
    expect(await t.storages.b!.usedBytes()).toBe(used);
    await t.close();
  }, 60_000);

  it('does not dedup across Spaces (different keys, different ID) or across a key rotation', async () => {
    const p = await createBlobPeers(['a', 'b']);
    const n = p.node('a');
    const A = await createBlobs({ core: n.core, keys: n.spaces.blobKeys, storage: createMemoryBlobStorage() });
    const other = await n.spaces.create('Other');
    const bytes = pattern(5000, 9);
    const inFirst = await A.attach(new Blob([bytes as BlobPart]), { space: p.space, obj: 'o1' });
    const inOther = await A.attach(new Blob([bytes as BlobPart]), { space: other.id, obj: 'o2' });
    expect(inOther.id).not.toBe(inFirst.id);
    expect(inOther.keyId).not.toBe(inFirst.keyId);

    await n.spaces.remove(p.space, p.node('b').spaces.session()!.user); // rotation
    await waitFor(async () => (await n.spaces.list()).find((s) => s.id === p.space)!.currentEpoch >= 1, 15_000, 'rotated');
    await p.settle(5);
    const afterRotation = await A.attach(new Blob([bytes as BlobPart]), { space: p.space, obj: 'o3' });
    expect(afterRotation.id).not.toBe(inFirst.id); // a new epoch key: a new blob
    expect(afterRotation.keyId).not.toBe(inFirst.keyId);
    await p.close();
  }, 120_000);
});
