// T050 (SC-004, US2.2): an interrupted transfer resumes by asking only for the chunks it does not have.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { laneType } from '@sync/testkit';
import { CHUNK_BYTES, createBlobs, decodeLaneMessage, type LaneMsg } from '../../src';
import { pattern, plainPeers, vectorProvider } from '../helpers';

/** Cut the link a↔b after `k` chunk messages have been handed to the network, then restart the receiver from its storage. */
async function interruptedThenResumed(n: number, k: number, seed = 1) {
  const t = await plainPeers(['a', 'b', 'b2'], { window: 4 }, seed, { skip: ['b2'] });
  const bytes = pattern(CHUNK_BYTES * n, seed);
  const ref = await t.attach('a', bytes);
  let chunks = 0;
  t.p.net.tap((from, to, m) => {
    if (from === 'a' && to === 'b' && laneType(m) === 'chunk' && ++chunks === k) t.p.net.sever('a', 'b');
  });
  const first = t.engines.b!.request(ref);
  first.catch(() => undefined);
  await new Promise((r) => setTimeout(r, 120)); // let everything that was in flight settle (or be lost)
  t.engines.b!.cancel(ref);
  const stored = await t.storages.b!.presentChunks(ref.id);

  // "restart": a new device on the same blob storage
  const b2 = await createBlobs({ core: t.p.core('b2'), keyProvider: await vectorProvider(), storage: t.storages.b! });
  const sentBefore = t.faults.sent.length;
  await b2.request(ref);
  const after = t.faults.sent.slice(sentBefore);
  const decoded = (from: string, to: string) =>
    after.filter((s) => s.from === from && s.to === to).flatMap((s) => {
      const d = decodeLaneMessage(s.bytes);
      return d.ok && 'msg' in d ? [d.msg] : [];
    });
  const sentChunks = decoded('a', 'b2').filter((m): m is Extract<LaneMsg, { type: 'chunk' }> => m.type === 'chunk').map((m) => m.index);
  const asked = decoded('b2', 'a')
    .filter((m): m is Extract<LaneMsg, { type: 'get' }> => m.type === 'get')
    .flatMap((m) => m.ranges.flatMap(([lo, hi]) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)));
  const got = new Uint8Array(await (await b2.toBlob(ref)).arrayBuffer());
  await b2.close();
  await t.close();
  return { stored, sentChunks, asked, ok: got.length === bytes.length && got.every((v, i) => v === bytes[i]), n };
}

describe('resume', () => {
  it('after a drop at about 37% and a restart from storage, no completed chunk is requested or re-sent', async () => {
    const n = 30;
    const r = await interruptedThenResumed(n, Math.round(n * 0.37));
    expect(r.stored.length).toBeGreaterThan(0);
    expect(r.stored.length).toBeLessThan(n);
    expect(r.sentChunks.filter((i) => r.stored.includes(i))).toEqual([]); // zero chunk messages for stored indexes
    expect(r.asked.filter((i) => r.stored.includes(i))).toEqual([]);
    expect([...new Set([...r.stored, ...r.sentChunks])].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
    expect(r.ok).toBe(true);
  }, 120_000);

  it('holds for an interruption at any chunk boundary (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 3, max: 8 }), fc.double({ min: 0, max: 0.999, noNaN: true }), fc.integer({ min: 1, max: 1000 }), async (n, frac, seed) => {
        const k = 1 + Math.floor(frac * (n - 1));
        const r = await interruptedThenResumed(n, k, seed);
        expect(r.sentChunks.filter((i) => r.stored.includes(i))).toEqual([]);
        expect(r.asked.filter((i) => r.stored.includes(i))).toEqual([]);
        expect(r.ok).toBe(true);
      }),
      { numRuns: 25 },
    );
  }, 300_000);

  it('keeps verified chunks when a transfer is cancelled, and finishes later', async () => {
    const t = await plainPeers(['a', 'b'], { window: 2 });
    const ref = await t.attach('a', pattern(CHUNK_BYTES * 12));
    const p = t.engines.b!.request(ref);
    p.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 15));
    t.engines.b!.cancel(ref);
    await expect(p).rejects.toMatchObject({ reason: 'cancelled' });
    expect(t.engines.b!.observe(ref).get()).toMatchObject({ state: 'failed', reason: 'cancelled' });
    const have = await t.storages.b!.presentChunks(ref.id);
    await t.engines.b!.request(ref);
    expect(t.engines.b!.observe(ref).get().state).toBe('available');
    expect(have.length).toBeLessThanOrEqual(12);
    await t.close();
  }, 60_000);
});
