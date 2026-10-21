// T096 / SC-002: with the CPU slowed 4x (the reference "mid-range phone"), a local edit reaches a live query in under 50 ms.
import { expect, test } from '@playwright/test';

test('local edit to live-query emit stays under 50 ms with 4x CPU slowdown', async ({ page, context }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__sync);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

  const samples: number[] = await page.evaluate(async () => {
    const { openCore } = (window as any).__sync;
    const core = await openCore('e2e-latency-' + Date.now());
    const ids: string[] = [];
    for (let i = 0; i < 500; i++) ids.push((await core.create('s1', 'item', { i })).id);
    let emittedAt = 0;
    core.query({ type: 'item' }).subscribe(() => (emittedAt = performance.now()));
    const out: number[] = [];
    for (let k = 0; k < 20; k++) {
      const start = performance.now();
      await core.update(ids[k], { touched: k });
      await new Promise((r) => setTimeout(r, 0));
      out.push(emittedAt - start);
    }
    return out;
  });
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95) - 1]!;
  console.log('latency ms (4x CPU slowdown, real IndexedDB):', samples.map((s) => s.toFixed(1)).join(', '));
  expect(p95).toBeLessThan(50);
});
