// T084: compaction never changes what a peer bootstrapped from the snapshot ends up with.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createTestCore, runScenario, scenarioArb, createFakeClock } from '@sync/testkit';

const runs = Number(process.env.CONVERGENCE_RUNS ?? 500);
const seed = process.env.CONVERGENCE_SEED ? Number(process.env.CONVERGENCE_SEED) : undefined;

describe('compaction keeps convergence (SC-004 extended)', () => {
  it(
    'a fresh peer built only from a compacted peer\'s snapshot has the same state as everyone',
    async () => {
      await fc.assert(
        fc.asyncProperty(scenarioArb, async (sc) => {
          const { hashes, cores } = await runScenario(sc, {}, { keepCores: true });
          expect(new Set(hashes).size).toBe(1);

          const source = cores![0]!;
          const before = await source.core.stateHash('s1');
          source.clock.advance(1000);
          await source.core.compact({ olderThanMs: 0 });
          expect(await source.core.stateHash('s1')).toBe(before);

          const fresh = await createTestCore({ clock: createFakeClock() });
          const snap = await source.core.exportSnapshot('s1');
          if (snap) await fresh.core.installSnapshot(snap);
          expect(await fresh.core.stateHash('s1')).toBe(before);

          // installing the same snapshot again changes nothing (idempotent)
          if (snap) await fresh.core.installSnapshot(snap);
          expect(await fresh.core.stateHash('s1')).toBe(before);
        }),
        { numRuns: runs, seed },
      );
    },
    30 * 60_000,
  );
});
