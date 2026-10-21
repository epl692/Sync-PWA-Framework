// T073 (Story 4 scenario 5): two browsers pair with codes only (no server in the path), sync, reload, re-pair.
import { expect, test } from '@playwright/test';

test('pairs two browsers with offer and answer codes and syncs offline', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  const space = `s-${Date.now()}`;
  const dbA = `rtc-a-${space}`;
  const dbB = `rtc-b-${space}`;

  const boot = async (page: typeof a, db: string) => {
    await page.goto('/');
    await page.waitForFunction(() => (window as any).__sync);
    await page.evaluate(async ([db, space]) => {
      const { core, rtc } = await (window as any).__sync.openRtcCore(db, [space]);
      Object.assign(window, { core, rtc, progress: [] as any[] });
      core.on((e: any) => e.kind === 'sync:progress' && (window as any).progress.push(e));
    }, [db, space]);
  };

  const pairUp = async () => {
    const offer = await a.evaluate(async () => (window as any).rtc.createOffer());
    expect(offer.code.startsWith('SP1.')).toBe(true);
    expect(offer.code.length).toBeLessThan(2500); // fits in a QR code
    const answer = await b.evaluate(async (code) => (window as any).rtc.acceptOffer(code), offer.code);
    await a.evaluate(async ([id, code]) => (window as any).rtc.acceptAnswer(id, code), [offer.sessionId, answer.code]);
  };

  await boot(a, dbA);
  await boot(b, dbB);
  const created = await a.evaluate(async (space) => (await (window as any).core.create(space, 'note', { n: 1 })).id, space);

  await pairUp();
  await b.waitForFunction(async ([id]) => !!(await (window as any).core.get(id)), [created], { timeout: 15_000 });

  // live edits both ways
  await a.evaluate(async ([id]) => (window as any).core.update(id, { n: 2 }), [created]);
  await b.waitForFunction(async ([id]) => (await (window as any).core.get(id))?.fields.n === 2, [created], { timeout: 10_000 });
  await b.evaluate(async ([id]) => (window as any).core.update(id, { m: 'from b' }), [created]);
  await a.waitForFunction(async ([id]) => (await (window as any).core.get(id))?.fields.m === 'from b', [created], { timeout: 10_000 });

  // reload both, make one more edit on A while they are apart, pair again: only the missing packet moves
  await a.reload();
  await b.reload();
  await boot(a, dbA);
  await boot(b, dbB);
  await a.evaluate(async ([id]) => (window as any).core.update(id, { n: 3 }), [created]);
  await pairUp();
  await b.waitForFunction(async ([id]) => (await (window as any).core.get(id))?.fields.n === 3, [created], { timeout: 15_000 });
  await b.waitForFunction(() => (window as any).progress.length > 0, undefined, { timeout: 5000 });
  const progress = await b.evaluate(() => (window as any).progress as { total?: number }[]);
  expect(progress.length).toBeGreaterThan(0);
  expect(progress[progress.length - 1]!.total).toBe(1);

  await ctxA.close();
  await ctxB.close();
});

test('a malformed pairing code is rejected with a clear error', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__sync);
  const err = await page.evaluate(async () => {
    const { rtc } = await (window as any).__sync.openRtcCore('rtc-err-' + Date.now(), ['s']);
    try {
      await rtc.acceptOffer('SP1.not-a-real-code');
      return null;
    } catch (e: any) {
      return { name: e.name, code: e.code };
    }
  });
  expect(err).toEqual({ name: 'PairingError', code: 'malformed' });
});
