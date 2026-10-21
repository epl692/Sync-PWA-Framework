// T058 (User Story 3, scenario 1): invite by link through the relay; a second browser joins, reads history and writes.
import { expect, test } from '@playwright/test';

test('a second browser accepts an invite link through the relay and shares encrypted data', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  const id = Date.now();
  for (const p of [a, b]) {
    await p.goto('/');
    await p.waitForFunction(() => (window as any).__sync);
  }
  await a.evaluate(async ([name]) => (window as any).node = await (window as any).__sync.openSecureNode(name, { url: 'ws://localhost:8787', approve: true }), [`own-${id}`]);
  await b.evaluate(async ([name]) => (window as any).node = await (window as any).__sync.openSecureNode(name, { url: 'ws://localhost:8787' }), [`joi-${id}`]);

  const { space, noteId, url } = await a.evaluate(async () => {
    const n = (window as any).node;
    const space = await n.spaces.create('Family');
    const note = await n.core.create(space.id, 'note', { text: 'before the invite' });
    const art = await n.spaces.invite(space.id, { role: 'editor', expiresAt: Date.now() + 3_600_000, maxUses: 1, approval: 'required' });
    return { space: space.id, noteId: note.id, url: art.url };
  });
  expect(url).toContain('#/join/');
  expect(new URL(url).search).toBe(''); // nothing but the fragment, which a static host never sees

  const joined = await b.evaluate(async (url) => (window as any).node.spaces.accept(url), url);
  expect(joined).toEqual({ space, role: 'editor' });
  await b.waitForFunction(async ([noteId]) => !!(await (window as any).node.core.get(noteId)), [noteId], { timeout: 20_000 });

  const wrote = await b.evaluate(async (space) => (await (window as any).node.core.create(space, 'note', { text: 'from the joiner' })).id, space);
  await a.waitForFunction(async ([id]) => !!(await (window as any).node.core.get(id)), [wrote], { timeout: 20_000 });

  // a second use of the single-use invite is refused
  const third = await browser.newContext();
  const c = await third.newPage();
  await c.goto('/');
  await c.waitForFunction(() => (window as any).__sync);
  await c.evaluate(async ([name]) => (window as any).node = await (window as any).__sync.openSecureNode(name, { url: 'ws://localhost:8787' }), [`thr-${id}`]);
  const refused = await c.evaluate(async (url) => {
    try {
      await (window as any).node.spaces.accept(url, { timeoutMs: 8000 });
      return 'accepted';
    } catch (e: any) {
      return e.reason ?? e.message;
    }
  }, url);
  expect(refused).toBe('used-up');

  await ctxA.close();
  await ctxB.close();
  await third.close();
});
