// T054 (FR-011): a missing blob downloads only when asked for, unless the app supplies a prefetch rule.
import { describe, expect, it } from 'vitest';
import { waitFor } from '@sync/testkit';
import { CHUNK_BYTES } from '../../src';
import { SPACE, pattern, plainPeers } from '../helpers';

describe('on demand and prefetch', () => {
  it('starts no download when an object with a reference is applied', async () => {
    const t = await plainPeers(['a', 'b']);
    const ref = await t.attach('a', pattern(CHUNK_BYTES * 2));
    await t.p.core('a').create(SPACE, 'note', { photo: ref as never });
    await waitFor(async () => (await t.p.core('b').query({ type: 'note' }).once()).length === 1, 10_000, 'object on b');
    await new Promise((r) => setTimeout(r, 150));
    expect(t.faults.count('get', 'b')).toBe(0);
    expect(t.engines.b!.observe(ref).get()).toMatchObject({ state: 'missing', reason: 'not-requested' });
    await t.close();
  }, 60_000);

  it('with a prefetch rule downloads matching references on its own and leaves the rest', async () => {
    const t = await plainPeers(['a', 'b'], { prefetch: (ref) => ref.size < 200_000 });
    const small = await t.attach('a', pattern(50_000, 1), 'o1');
    const large = await t.attach('a', pattern(CHUNK_BYTES * 3, 2), 'o2');
    await t.p.core('a').create(SPACE, 'note', { photo: small as never, big: large as never });
    await waitFor(() => t.engines.b!.observe(small).get().state === 'available', 10_000, 'small blob prefetched');
    expect(t.engines.b!.observe(large).get()).toMatchObject({ state: 'missing', reason: 'not-requested' });
    await t.close();
  }, 60_000);

  it('a throwing prefetch rule never breaks the engine', async () => {
    const t = await plainPeers(['a', 'b'], {
      prefetch: () => {
        throw new Error('bad rule');
      },
    });
    const ref = await t.attach('a', pattern(1000));
    await t.p.core('a').create(SPACE, 'note', { photo: ref as never });
    await new Promise((r) => setTimeout(r, 200));
    await t.engines.b!.request(ref);
    expect(t.engines.b!.observe(ref).get().state).toBe('available');
    await t.close();
  }, 60_000);

  it('request joins a download already in flight and does not duplicate it', async () => {
    const t = await plainPeers(['a', 'b']);
    const ref = await t.attach('a', pattern(CHUNK_BYTES * 5));
    await Promise.all([t.engines.b!.request(ref), t.engines.b!.request(ref, { priority: 'high' }), t.engines.b!.request(ref)]);
    expect(t.faults.count('chunk', 'a')).toBe(5);
    await t.close();
  }, 60_000);

  it('serves a high-priority request before a low-priority one when the window is tight', async () => {
    const t = await plainPeers(['a', 'b'], { window: 1, maxSources: 1 });
    const low = await t.attach('a', pattern(CHUNK_BYTES * 8, 1), 'o1');
    const high = await t.attach('a', pattern(CHUNK_BYTES * 8, 2), 'o2');
    const done: string[] = [];
    const lowP = t.engines.b!.request(low, { priority: 'low' }).then(() => done.push('low'));
    const highP = t.engines.b!.request(high, { priority: 'high' }).then(() => done.push('high'));
    await Promise.all([lowP, highP]);
    expect(done[0]).toBe('high');
    await t.close();
  }, 60_000);

  it('an AbortSignal rejects the request and stops a download nobody else waits for', async () => {
    const t = await plainPeers(['a', 'b'], { window: 1 });
    const ref = await t.attach('a', pattern(CHUNK_BYTES * 30));
    const ctl = new AbortController();
    const p = t.engines.b!.request(ref, { signal: ctl.signal });
    await new Promise((r) => setTimeout(r, 10));
    ctl.abort();
    await expect(p).rejects.toBeDefined();
    await new Promise((r) => setTimeout(r, 100));
    expect(t.engines.b!.observe(ref).get().state).not.toBe('downloading');
    await t.close();
  }, 60_000);
});
