// T059: a flood of offers or requests from one peer is bounded; normal transfers are unaffected (blob-protocol.md Rules).
import { describe, expect, it } from 'vitest';
import { waitFor } from '@sync/testkit';
import { CHUNK_BYTES, decodeLaneMessage, encodeLaneMessage, type LaneMsg } from '../../src';
import { SPACE, pattern, plainPeers } from '../helpers';

async function raw(t: Awaited<ReturnType<typeof plainPeers>>, name: string) {
  const lane = t.p.core(name).lane(0xb1);
  const got: LaneMsg[] = [];
  lane.onMessage((_k, b) => {
    const d = decodeLaneMessage(b);
    if (d.ok && 'msg' in d) got.push(d.msg);
  });
  await waitFor(() => lane.peers().length === 1, 10_000, 'raw lane peer');
  const toA = (m: LaneMsg) => lane.send('memory:a', encodeLaneMessage(m));
  await toA({ type: 'hello', v: 1, window: 8, maxChunks: 4096, serve: true });
  return { got, toA };
}

describe('flood limits', () => {
  it('answers at most 64 offers per second from one peer and drops the rest', async () => {
    const t = await plainPeers(['a', 'raw'], {}, 1, { skip: ['raw'] });
    const ref = await t.attach('a', pattern(2000));
    const r = await raw(t, 'raw');
    for (let i = 0; i < 200; i++) await r.toA({ type: 'offer', space: SPACE, id: ref.id, size: ref.size });
    await new Promise((res) => setTimeout(res, 300));
    const answered = r.got.filter((m) => m.type === 'stored').length;
    expect(answered).toBeGreaterThan(0);
    expect(answered).toBeLessThanOrEqual(64);
    await t.close();
  }, 60_000);

  it('answers `busy` to a get that would queue more than 256 ranges, without serving it', async () => {
    const t = await plainPeers(['a', 'raw'], {}, 1, { skip: ['raw'] });
    const ref = await t.attach('a', pattern(CHUNK_BYTES * 2));
    const r = await raw(t, 'raw');
    const ranges: Array<[number, number]> = Array.from({ length: 300 }, (_, i) => [i * 2, i * 2]);
    await r.toA({ type: 'get', id: ref.id, manifest: true, space: SPACE, ranges });
    await waitFor(() => r.got.some((m) => m.type === 'reject' && m.reason === 'busy'), 5000, 'busy');
    expect(r.got.some((m) => m.type === 'chunk')).toBe(false);
    await t.close();
  }, 60_000);

  it('does not iterate a range far beyond the end of the blob (a huge upper bound answers with a miss at once)', async () => {
    const t = await plainPeers(['a', 'raw'], {}, 1, { skip: ['raw'] });
    const ref = await t.attach('a', pattern(CHUNK_BYTES));
    const r = await raw(t, 'raw');
    await r.toA({ type: 'get', id: ref.id, manifest: false, space: SPACE, ranges: [[0, 0xffffffff]] });
    await waitFor(() => r.got.some((m) => m.type === 'miss'), 5000, 'miss');
    const miss = r.got.find((m) => m.type === 'miss') as Extract<LaneMsg, { type: 'miss' }>;
    expect(miss.ranges).toEqual([[1, 0xffffffff]]);
    expect(r.got.filter((m) => m.type === 'chunk')).toHaveLength(1);
    await t.close();
  }, 60_000);

  it('does not slow a normal transfer: a wide window fetch of a 40-chunk blob completes with no busy answer', async () => {
    const t = await plainPeers(['a', 'b'], { window: 40 });
    const ref = await t.attach('a', pattern(CHUNK_BYTES * 40));
    await t.engines.b!.request(ref);
    expect(t.faults.sent.some((s) => s.from === 'a' && (decodeLaneMessage(s.bytes) as { msg?: LaneMsg }).msg?.type === 'reject')).toBe(false);
    expect(t.engines.b!.observe(ref).get().state).toBe('available');
    await t.close();
  }, 60_000);
});
