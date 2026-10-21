// T093: when IndexedDB reports QuotaExceededError mid-transaction, the core raises a typed error, rolls the
// whole write back in real IndexedDB, keeps earlier data, and warns the app.
//
// Headless Chromium does not enforce a quota on IndexedDB writes (even with a CDP quota override), so the
// browser's failure is injected: the Nth write throws the same DOMException a real overflow produces.
import { expect, test } from '@playwright/test';

test('a quota failure in the middle of a write is typed, atomic, and leaves earlier data intact', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__sync);

  const outcome = await page.evaluate(async () => {
    const { openCore } = (window as any).__sync;
    const core = await openCore('e2e-quota-' + Date.now());
    const events: string[] = [];
    core.on((e: any) => events.push(e.kind));

    const kept: string[] = [];
    for (let i = 0; i < 3; i++) kept.push((await core.create('s1', 'note', { i })).id);

    const originalPut = IDBObjectStore.prototype.put;
    let allowed = 0; // fail the very next write to the packet log
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'packets' && allowed-- <= 0) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return originalPut.apply(this, args);
    };
    let failure: { name: string; code: string } | null = null;
    try {
      await core.create('s1', 'note', { i: 'overflow' });
    } catch (e: any) {
      failure = { name: e.name, code: e.code };
    }
    IDBObjectStore.prototype.put = originalPut;

    const afterFailure = (await core.query({ type: 'note' }).once()).length;
    await core.create('s1', 'note', { i: 'after recovery' }); // the core keeps working once space is available
    return { failure, events, afterFailure, final: (await core.query({ type: 'note' }).once()).length };
  });

  expect(outcome.failure).toEqual({ name: 'StorageQuotaError', code: 'storage-quota' });
  expect(outcome.events).toContain('storage:pressure');
  expect(outcome.afterFailure).toBe(3); // the failed write left nothing behind
  expect(outcome.final).toBe(4);
});
