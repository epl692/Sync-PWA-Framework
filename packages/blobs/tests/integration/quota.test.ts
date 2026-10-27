// T053 (edge case): the storage quota is hit in the middle of a download.
import { describe, expect, it } from 'vitest';
import { BlobFetchError, CHUNK_BYTES } from '../../src';
import { pattern, plainPeers } from '../helpers';

const STORED = CHUNK_BYTES + 28; // one full chunk: nonce 12 + plaintext + tag 16

describe('quota during a download', () => {
  it('fails with `quota`, keeps the verified chunks, emits blob:failed, and resumes once there is room', async () => {
    const t = await plainPeers(['a', 'b'], { window: 2 });
    const ref = await t.attach('a', pattern(CHUNK_BYTES * 6));
    t.storages.b!.setQuota(STORED * 3 + 10);
    const failed: string[] = [];
    t.engines.b!.on('blob:failed', (e) => failed.push(e.reason));
    const err = await t.engines.b!.request(ref).catch((e) => e);
    expect(err).toBeInstanceOf(BlobFetchError);
    expect((err as BlobFetchError).reason).toBe('quota');
    expect(t.engines.b!.observe(ref).get()).toMatchObject({ state: 'failed', reason: 'quota' });
    expect(failed).toEqual(['quota']);
    const kept = await t.storages.b!.presentChunks(ref.id);
    expect(kept.length).toBe(3);

    t.storages.b!.setQuota(undefined);
    const before = t.faults.count('chunk', 'a');
    await t.engines.b!.request(ref);
    expect(t.engines.b!.observe(ref).get().state).toBe('available');
    expect(t.faults.count('chunk', 'a') - before).toBeLessThanOrEqual(6 - kept.length + 2); // only what was missing (plus any in flight)
    await t.close();
  }, 60_000);

  it('does not evict anything by itself with the default configuration', async () => {
    const t = await plainPeers(['a', 'b']);
    const keep = await t.attach('b', pattern(CHUNK_BYTES * 2, 9), 'keep');
    const ref = await t.attach('a', pattern(CHUNK_BYTES * 4));
    t.storages.b!.setQuota((await t.storages.b!.usedBytes()) + STORED);
    await t.engines.b!.request(ref).catch(() => undefined);
    expect(await t.storages.b!.presentChunks(keep.id)).toHaveLength(2);
    await t.close();
  }, 60_000);
});
