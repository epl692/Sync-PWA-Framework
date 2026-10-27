// T034 (SC-001, FR-003): packets keep flowing while a large blob transfers. Default 24 MB; BLOB_PERF_MB=100 for the full
// 100 MB measurement recorded in validation.md. One process and one thread play both devices, so the "2x idle" criterion
// (idle latency here is about a millisecond) is measured by the browser end-to-end test; this test holds the absolute bound.
import { describe, expect, it } from 'vitest';
import { CHUNK_BYTES } from '../../src';
import { SPACE, plainPeers } from '../helpers';

const MB = Number(process.env.BLOB_PERF_MB ?? 24);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))]!;

describe(`packet latency during a ${MB} MB transfer`, () => {
  it('adds less than 250 ms at the 95th percentile', async () => {
    const t = await plainPeers(['a', 'b']);
    const sentAt = new Map<string, number>();
    const arrivedAt = new Map<string, number>();
    t.p.core('b').onApplied(({ body }) => {
      if (body.type === 'tick') arrivedAt.set(body.obj, performance.now());
    });
    const tick = async (n: number): Promise<string> => {
      const t0 = performance.now();
      const o = await t.p.core('a').create(SPACE, 'tick', { n });
      sentAt.set(o.id, t0);
      return o.id;
    };
    const latency = (ids: string[]) => ids.map((id) => (arrivedAt.get(id) ?? performance.now() + 60_000) - sentAt.get(id)!);

    const n = Math.ceil((MB * 1024 * 1024) / CHUNK_BYTES);
    const bytes = new Uint8Array(CHUNK_BYTES * n);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 3) & 0xff;
    const t0 = performance.now();
    const ref = await t.attach('a', bytes);
    const attachMs = performance.now() - t0;
    await sleep(100);

    const idleIds: string[] = [];
    for (let i = 0; i < 30; i++) {
      idleIds.push(await tick(i));
      await sleep(20);
    }
    await sleep(300);

    let done = false;
    const t1 = performance.now();
    const download = t.engines.b!.request(ref).finally(() => (done = true));
    const duringIds: string[] = [];
    while (!done) {
      duringIds.push(await tick(duringIds.length));
      await sleep(20);
    }
    await download;
    const transferMs = performance.now() - t1;
    await sleep(300);

    const idle = p95(latency(idleIds));
    const during = p95(latency(duringIds));
    console.log(`${MB} MB: attach ${attachMs.toFixed(0)} ms (${((MB * 1000) / attachMs).toFixed(1)} MB/s), transfer ${transferMs.toFixed(0)} ms, packets during ${duringIds.length}, p95 idle ${idle.toFixed(1)} ms, p95 during ${during.toFixed(1)} ms`);
    expect(duringIds.length).toBeGreaterThan(3);
    expect(during - idle).toBeLessThan(250);
    expect(t.engines.b!.observe(ref).get().state).toBe('available');
    await t.close();
  }, 900_000);
});
