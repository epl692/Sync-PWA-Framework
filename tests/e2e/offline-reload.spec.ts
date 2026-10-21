// T032: offline create, edit, delete, reload with real IndexedDB in Chromium.
import { expect, test } from '@playwright/test';

test('CRUD works with no transport and survives a reload', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__sync);

  const ids = await page.evaluate(async () => {
    const { openCore } = (window as any).__sync;
    const core = await openCore('e2e-offline');
    const keep = await core.create('s1', 'note', { title: 'keep me' });
    const edit = await core.create('s1', 'note', { title: 'before' });
    const gone = await core.create('s1', 'note', { title: 'delete me' });
    await core.update(edit.id, { title: 'after' });
    await core.remove(gone.id);
    return { keep: keep.id, edit: edit.id, gone: gone.id };
  });

  await page.reload();
  await page.waitForFunction(() => (window as any).__sync);

  const after = await page.evaluate(async (ids) => {
    const { openCore } = (window as any).__sync;
    const core = await openCore('e2e-offline');
    return {
      notes: (await core.query({ type: 'note' }).once()).map((o: any) => o.fields.title).sort(),
      gone: await core.get(ids.gone),
    };
  }, ids);

  expect(after.notes).toEqual(['after', 'keep me']);
  expect(after.gone).toBeUndefined();
});
