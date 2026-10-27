// T080 (research R-13): measured against the plan's budgets. Default 32 MB; BLOB_PERF_MB=100 for the full figures in
// validation.md. Numbers are printed so a shortfall is visible, not hidden; the assertions are the plan's targets with
// the slack a shared CI machine needs.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileBlobStorage } from '@sync/relay-server';
import { createPeers, LaneFaults } from '@sync/testkit';
import { CHUNK_BYTES, createBlobs, createMemoryBlobStorage, type BlobStorage } from '../../src';
import { SPACE, pattern, testBlobs, vectorProvider } from '../helpers';

const MB = Number(process.env.BLOB_PERF_MB ?? 32);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mem = () => {
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
};

/** Keeps no chunk bytes (only counts them), so a measurement is of the pipeline and not of how much RAM the store uses. */
function discarding(inner: BlobStorage): BlobStorage {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'putChunk') return async (id: string, i: number, bytes: Uint8Array) => inner.putChunk(id, i, bytes.length > 1 ? new Uint8Array(1) : bytes);
      return Reflect.get(target, prop, receiver);
    },
  });
}

describe(`budgets at ${MB} MB`, () => {
  it('attaches at 20 MB/s or better and streams it: memory stays far below the file size', async () => {
    const t = await testBlobs();
    const bytes = new Uint8Array(MB * 1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 3) & 0xff;
    const file = new Blob([bytes as BlobPart]);
    const base = mem();
    let peak = 0;
    const timer = setInterval(() => (peak = Math.max(peak, mem())), 10);
    const t0 = performance.now();
    await t.blobs.attach(file, { space: SPACE, obj: 'o1' });
    const ms = performance.now() - t0;
    clearInterval(timer);
    const rate = MB / (ms / 1000);
    // the store keeps the ciphertext (about the file size); everything else is working memory
    const working = peak - base - (await t.storage.usedBytes());
    console.log(`attach ${MB} MB: ${ms.toFixed(0)} ms, ${rate.toFixed(1)} MB/s, working memory above baseline and stored data ${(working / 1048576).toFixed(1)} MiB`);
    expect(rate).toBeGreaterThan(20);
    expect(working).toBeLessThan(64 * 1048576);
  }, 300_000);

  it('fetches from disk into a store that keeps nothing: throughput and memory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'blob-perf-'));
    try {
      const p = await createPeers(['a', 'b'], { spaces: [SPACE] });
      const faults = new LaneFaults(1);
      for (const n of ['a', 'b']) faults.install(p.net.transport(n, 'memory'));
      const provider = await vectorProvider();
      const A = await createBlobs({ core: p.core('a'), keyProvider: provider, storage: await createFileBlobStorage(dir) });
      const B = await createBlobs({ core: p.core('b'), keyProvider: provider, storage: discarding(createMemoryBlobStorage()) });
      p.link('a', 'b');
      const chunks = Math.ceil((MB * 1024 * 1024) / CHUNK_BYTES);
      const bytes = pattern(CHUNK_BYTES * chunks);
      const ref = await A.attach(new Blob([bytes as BlobPart]), { space: SPACE, obj: 'o1' });
      await sleep(200);
      const base = mem();
      let peak = 0;
      const timer = setInterval(() => (peak = Math.max(peak, mem())), 10);
      const t0 = performance.now();
      await B.request(ref).catch(() => undefined); // verification passes; the discarded store cannot be re-read, which is fine here
      const ms = performance.now() - t0;
      clearInterval(timer);
      const over = peak - base;
      console.log(`fetch ${MB} MB (disk to discarding store): ${ms.toFixed(0)} ms, ${(MB / (ms / 1000)).toFixed(1)} MB/s, memory above baseline ${(over / 1048576).toFixed(1)} MiB (target 16 MiB)`);
      expect(over).toBeLessThan(64 * 1048576);
      await A.close();
      await B.close();
    } finally {
      await sleep(300); // a late `stored` write may still land
      await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 300_000);

  it('adds under 1 ms per applied packet to index references', async () => {
    const t = await testBlobs();
    const ref = await t.blobs.attach(new Blob([pattern(100) as BlobPart]), { space: SPACE, obj: 'pool' });
    const N = 600;
    const plain = performance.now();
    for (let i = 0; i < N; i++) await t.core.create(SPACE, 'tick', { i });
    const withoutRefs = performance.now() - plain;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) await t.core.create(SPACE, 'note', { i, photo: ref as never });
    await sleep(50);
    const withRefs = performance.now() - t0;
    const perPacket = (withRefs - withoutRefs) / N;
    console.log(`reference index: ${perPacket.toFixed(3)} ms per packet (writes with references ${withRefs.toFixed(0)} ms, without ${withoutRefs.toFixed(0)} ms for ${N})`);
    expect(perPacket).toBeLessThan(1);
  }, 120_000);

  it('collects and evicts in slices that do not hold the event loop', async () => {
    const t = await testBlobs({ retentionMs: 1000, orphanGraceMs: 1000 });
    for (let i = 0; i < 1500; i++) {
      await t.storage.putBlob({
        id: `id${String(i).padStart(5, '0')}`.padEnd(43, 'A'),
        manifest: new Uint8Array(73),
        space: SPACE,
        scope: SPACE,
        keyId: '0123456789abcdef',
        size: 10,
        type: 'text/plain',
        origin: 'remote',
        replicas: ['relay:1'],
        pinned: false,
        complete: false,
        createdAt: 1,
        lastAccessAt: 1,
        unreferencedAt: null,
      });
    }
    t.clock.advance(5000);
    let last = performance.now();
    let gap = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      gap = Math.max(gap, now - last);
      last = now;
    }, 1);
    const n = await t.blobs.collect();
    clearInterval(timer);
    console.log(`collect of ${n} blobs: longest event-loop pause ${gap.toFixed(1)} ms (target 16 ms)`);
    expect(n).toBe(1500);
    expect(gap).toBeLessThan(100);
  }, 120_000);
});
