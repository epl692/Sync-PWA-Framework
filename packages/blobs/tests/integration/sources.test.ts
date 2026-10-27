// T051: several holders share the work, one dying mid-transfer is covered by another, and slow, reordering links still work.
import { describe, expect, it } from 'vitest';
import { laneType } from '@sync/testkit';
import { CHUNK_BYTES } from '../../src';
import { pattern, plainPeers } from '../helpers';

describe('multiple sources', () => {
  it('splits the chunks between two holders so that each is asked for part of the blob', async () => {
    const t = await plainPeers(['a', 'c', 'b']);
    const n = 16;
    const bytes = pattern(CHUNK_BYTES * n);
    const ref = await t.attach('a', bytes);
    await t.attach('c', bytes);
    await t.engines.b!.request(ref);
    const fromA = t.faults.count('chunk', 'a');
    const fromC = t.faults.count('chunk', 'c');
    expect(fromA).toBeGreaterThan(0);
    expect(fromC).toBeGreaterThan(0);
    expect(fromA + fromC).toBe(n); // every chunk exactly once
    await t.close();
  }, 60_000);

  it('completes from the other holder when one goes away mid-transfer', async () => {
    const t = await plainPeers(['a', 'c', 'b'], { window: 2, requestTimeoutMs: 2000 });
    t.faults.delayMs = 8;
    const bytes = pattern(CHUNK_BYTES * 20, 3);
    const ref = await t.attach('a', bytes);
    await t.attach('c', bytes);
    let seen = 0;
    t.p.net.tap((from, to, m) => {
      if (from === 'c' && to === 'b' && laneType(m) === 'chunk' && ++seen === 2) t.p.net.sever('c', 'b');
    });
    await t.engines.b!.request(ref);
    const got = new Uint8Array(await (await t.engines.b!.toBlob(ref)).arrayBuffer());
    expect(got.every((v, i) => v === bytes[i])).toBe(true);
    expect(t.faults.count('chunk', 'a')).toBeGreaterThan(t.faults.count('chunk', 'c'));
    await t.close();
  }, 60_000);

  it('works over a slow, reordering link', async () => {
    const t = await plainPeers(['a', 'b'], { requestTimeoutMs: 500 });
    t.faults.delayMs = 5;
    t.faults.jitterMs = 25;
    t.faults.affect = (m) => laneType(m) !== 'hello';
    const bytes = pattern(CHUNK_BYTES * 6 + 9, 5);
    const ref = await t.attach('a', bytes);
    await t.engines.b!.request(ref);
    const got = new Uint8Array(await (await t.engines.b!.toBlob(ref)).arrayBuffer());
    expect(got.length).toBe(bytes.length);
    expect(got.every((v, i) => v === bytes[i])).toBe(true);
    await t.close();
  }, 60_000);

  it('recovers from lost get and chunk messages by asking again after the timeout', async () => {
    const t = await plainPeers(['a', 'b'], { requestTimeoutMs: 120 });
    const ref = await t.attach('a', pattern(CHUNK_BYTES * 4));
    let dropped = 0;
    t.faults.dropRate = 1;
    t.faults.affect = (m) => (laneType(m) === 'chunk' || laneType(m) === 'get') && dropped++ < 5; // lose the first five
    await t.engines.b!.request(ref);
    expect(t.faults.stats.dropped).toBeGreaterThan(0);
    expect(t.engines.b!.observe(ref).get().state).toBe('available');
    await t.close();
  }, 60_000);
});
