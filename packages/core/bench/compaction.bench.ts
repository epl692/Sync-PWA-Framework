// T085 / SC-006: a Space with 100k historical packets shrinks by at least 80% after compaction, state unchanged.
// Run: npm run bench -w @sync/core
import { bench, describe } from 'vitest';
import { createMemoryStorage } from '@sync/core';
import { createTestCore, remoteEnvelope } from '@sync/testkit';

const PACKETS = Number(process.env.BENCH_PACKETS ?? 100_000);
const OBJECTS = 2_000;
const DAY = 24 * 60 * 60 * 1000;

describe('compaction', () => {
  bench(
    `${PACKETS} packets -> snapshot`,
    async () => {
      const storage = createMemoryStorage();
      const t = await createTestCore({ storage, retentionWindowMs: DAY, batch: { packets: 500 } });
      const raws: Uint8Array[] = [];
      const started = t.clock.now();
      for (let i = 0; i < PACKETS; i++) {
        const e = await remoteEnvelope(
          { obj: `o${i % OBJECTS}`, op: i < OBJECTS ? 'create' : 'update', type: 'item', fields: { n: i, label: `label ${i % 50}` } },
          { author: `AUTHOR${i % 4}`, seq: Math.floor(i / 4) + 1, wall: started + i },
        );
        raws.push(e.raw);
        if (raws.length === 1000) await t.core.ingestBatch(raws.splice(0), 'bench');
      }
      await t.core.ingestBatch(raws, 'bench');

      const hash = await t.core.stateHash('s1');
      const usage = async () => (await storage.estimate!())!.usageBytes;
      const before = await usage();
      t.clock.advance(10 * DAY);
      const r = await t.core.compact();
      const after = await usage();
      const reduction = 1 - after / before;
      console.log(`packets removed ${r.packetsRemoved}, storage ${before} -> ${after} bytes (${(reduction * 100).toFixed(1)}% smaller)`);
      if ((await t.core.stateHash('s1')) !== hash) throw new Error('state changed by compaction');
      if (reduction < 0.8) throw new Error(`SC-006 not met: only ${(reduction * 100).toFixed(1)}% reduction`);
    },
    { iterations: 1, warmupIterations: 0, time: 0 },
  );
});
