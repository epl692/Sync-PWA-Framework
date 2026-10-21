// T047 / SC-003: an edit in one browser reaches another through the relay server within 1 s (p95).
import { expect, test } from '@playwright/test';

test('edits propagate between two browsers through the relay server', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  for (const p of [a, b]) {
    await p.goto('/');
    await p.waitForFunction(() => (window as any).__sync);
  }
  const space = `s-${Date.now()}`;
  const url = 'ws://localhost:8787';

  await a.evaluate(async ([space, url]) => {
    (window as any).core = await (window as any).__sync.openSyncedCore('a-' + space, url, [space]);
  }, [space, url]);
  await b.evaluate(async ([space, url]) => {
    const core = await (window as any).__sync.openSyncedCore('b-' + space, url, [space]);
    (window as any).core = core;
    (window as any).arrivals = {};
    core.query({ type: 'note' }).subscribe((rows: any[]) => {
      for (const r of rows) (window as any).arrivals[r.fields.n + ':' + r.fields.v] ??= Date.now();
    });
  }, [space, url]);

  // let both sockets connect and exchange hello/summary
  await a.waitForTimeout(500);

  const sent: Record<string, number> = {};
  const id = await a.evaluate(async (space) => (await (window as any).core.create(space, 'note', { n: 0, v: 0 })).id, space);
  for (let i = 1; i <= 20; i++) {
    sent[`0:${i}`] = await a.evaluate(async ([id, i]) => {
      const t = Date.now();
      await (window as any).core.update(id, { n: 0, v: i });
      return t;
    }, [id, i] as [string, number]);
    await a.waitForTimeout(20);
  }
  await b.waitForFunction((n) => Object.keys((window as any).arrivals).length >= n, 21, { timeout: 10_000 });

  const arrivals = await b.evaluate(() => (window as any).arrivals as Record<string, number>);
  const latencies = Object.entries(sent).map(([k, t0]) => arrivals[k]! - t0).sort((x, y) => x - y);
  const p95 = latencies[Math.floor(latencies.length * 0.95) - 1]!;
  console.log('latencies ms', latencies.join(','));
  expect(p95).toBeLessThan(1000);

  // and the reverse direction: an edit in B reaches A
  await b.evaluate(async ([id]) => (window as any).core.update(id, { n: 1 }), [id]);
  await a.waitForFunction(async (id) => (await (window as any).core.get(id))?.fields.n === 1, id, { timeout: 5000 });
  await ctxA.close();
  await ctxB.close();
});
