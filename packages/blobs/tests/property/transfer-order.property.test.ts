// T049: with any reordering, duplication and loss of get, chunk, manifest, miss, offer and stored messages between 2 to 4
// peers, every requester ends with the identical verified blob and storage holds exactly one copy of each chunk.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { laneType } from '@sync/testkit';
import { CHUNK_BYTES } from '../../src';
import { pattern, plainPeers } from '../helpers';

const RUNS = Number(process.env.BLOB_ORDER_RUNS ?? 40);

describe('transfers under reordering, duplication and loss (property)', () => {
  it('converge on one verified copy per requester', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 4 }),
        fc.integer({ min: 1, max: CHUNK_BYTES * 3 + 77 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 0, max: 25 }),
        fc.double({ min: 0, max: 0.25, noNaN: true }),
        fc.integer({ min: 1, max: 1e6 }),
        async (peerCount, size, dup, jitter, drop, seed) => {
          const names = ['a', 'b', 'c', 'd'].slice(0, peerCount);
          const t = await plainPeers(names, { requestTimeoutMs: 150, window: 3 }, seed);
          try {
            // hello is the handshake and has no retransmission: everything else may be lost
            t.faults.affect = (m) => laneType(m) !== 'hello';
            t.faults.dupRate = dup;
            t.faults.jitterMs = jitter;
            t.faults.dropRate = drop;
            const bytes = pattern(size, seed & 0xffff);
            const ref = await t.attach('a', bytes);
            const n = Math.ceil(size / CHUNK_BYTES);
            await Promise.all(names.slice(1).map((name) => t.engines[name]!.request(ref)));
            for (const name of names.slice(1)) {
              const stored = t.storages[name]!;
              expect(await stored.presentChunks(ref.id)).toEqual(Array.from({ length: n }, (_, i) => i));
              let sum = 0;
              for (let i = 0; i < n; i++) sum += (await stored.getChunk(ref.id, i))!.length;
              expect(await stored.usedBytes()).toBe(sum); // exactly one copy of each chunk
              const got = new Uint8Array(await (await t.engines[name]!.toBlob(ref)).arrayBuffer());
              expect(got.length).toBe(size);
              expect(got.every((v, i) => v === bytes[i])).toBe(true);
            }
          } finally {
            await t.close();
          }
        },
      ),
      { numRuns: RUNS },
    );
  }, 600_000);
});
