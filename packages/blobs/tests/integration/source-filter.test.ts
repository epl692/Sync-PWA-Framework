// Spec 005 R-05: an app can keep a slow transport out of a large transfer; the transfer waits and then goes ahead by itself.
import { describe, expect, it } from 'vitest';
import { waitFor } from '@sync/testkit';
import { CHUNK_BYTES } from '../../src';
import { pattern, plainPeers } from '../helpers';

describe('sourceFilter', () => {
  it('a blob no eligible peer can serve waits, then completes when the filter allows it', async () => {
    let allow = false;
    const t = await plainPeers(['a', 'b'], { sourceFilter: () => allow });
    const ref = await t.attach('a', pattern(CHUNK_BYTES + 10, 3));
    const done = t.engines.b!.request(ref).then(() => true);
    await new Promise((r) => setTimeout(r, 300));
    expect(t.engines.b!.observe(ref).get().state).not.toBe('available');
    expect(t.faults.count('chunk', 'a')).toBe(0); // nothing was pulled over the excluded peer
    allow = true;
    // a new connection (or any change that re-evaluates sources) lets it proceed; here the retry timer does
    await t.engines.b!.request(ref).catch(() => undefined);
    await waitFor(() => t.engines.b!.observe(ref).get().state === 'available', 20_000, 'the blob after the filter allowed it');
    void done;
    await t.close();
  }, 60_000);

  it('a filter that looks at the size lets small blobs through and holds big ones back', async () => {
    const t = await plainPeers(['a', 'b'], { sourceFilter: (_p, ref) => ref.size <= CHUNK_BYTES });
    const small = await t.attach('a', pattern(1000, 1), 'o1');
    const big = await t.attach('a', pattern(CHUNK_BYTES * 2, 2), 'o2');
    await t.engines.b!.request(small);
    expect(t.engines.b!.observe(small).get().state).toBe('available');
    void t.engines.b!.request(big).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));
    expect(t.engines.b!.observe(big).get().state).not.toBe('available');
    await t.close();
  }, 60_000);

  it('the filter sees the transport and a throwing filter never stalls transfers', async () => {
    const seen: string[] = [];
    const t = await plainPeers(['a', 'b'], {
      sourceFilter: (peer) => {
        seen.push(peer.transport);
        throw new Error('boom');
      },
    });
    const ref = await t.attach('a', pattern(500, 4));
    await t.engines.b!.request(ref);
    expect(t.engines.b!.observe(ref).get().state).toBe('available');
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(['memory']));
    await t.close();
  }, 60_000);
});
