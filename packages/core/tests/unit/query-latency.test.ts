// T029 / SC-002: local edit to live-query emit in under 50 ms.
// CI approximates a mid-range phone with the reference profile (4x CPU slowdown); this asserts a scaled budget.
import { describe, expect, it } from 'vitest';
import { createTestCore } from '@sync/testkit';

describe('local edit latency (SC-002)', () => {
  it('emits to a live query in under 50 ms with 2,000 objects loaded', async () => {
    const t = await createTestCore();
    const ids: string[] = [];
    for (let i = 0; i < 2000; i++) ids.push((await t.core.create('s1', 'item', { i })).id);

    const budgetMs = 50 * Number(process.env.CPU_SLOWDOWN ?? 1) || 50;
    let emittedAt = 0;
    t.core.query({ type: 'item' }).subscribe(() => (emittedAt = performance.now()));

    const samples: number[] = [];
    for (let k = 0; k < 20; k++) {
      const start = performance.now();
      await t.core.update(ids[k]!, { touched: k });
      await new Promise((r) => setTimeout(r, 0));
      samples.push(emittedAt - start);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95) - 1]!;
    expect(p95).toBeLessThan(budgetMs);
  });
});
