// T058 (User Story 3, scenario 2; SC-004): with no network, two browsers pair by codes and the invite is accepted in under 60 s.
import { expect, test } from '@playwright/test';

test('an invite is accepted over a local WebRTC link with the network offline, in under 60 seconds', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  const id = Date.now();
  for (const p of [a, b]) {
    await p.goto('/');
    await p.waitForFunction(() => (window as any).__sync);
  }
  await a.evaluate(async ([name]) => (window as any).node = await (window as any).__sync.openSecureNode(name, { rtc: true, approve: true }), [`own-${id}`]);
  await b.evaluate(async ([name]) => (window as any).node = await (window as any).__sync.openSecureNode(name, { rtc: true }), [`joi-${id}`]);

  const started = Date.now();
  const { space, noteId, url, svgLength } = await a.evaluate(async () => {
    const n = (window as any).node;
    const space = await n.spaces.create('Hike');
    const note = await n.core.create(space.id, 'note', { text: 'trail notes' });
    const art = await n.spaces.invite(space.id, { role: 'viewer', expiresAt: Date.now() + 3_600_000, maxUses: 1, approval: 'required' });
    return { space: space.id, noteId: note.id, url: art.url, svgLength: (window as any).__sync.qrToSvg(art.qrPayload).length };
  });
  expect(svgLength).toBeGreaterThan(1000); // the invite fits a QR code

  // the two-step exchange: the invite QR (already in hand), then the pairing codes
  const offer = await a.evaluate(async () => (window as any).node.rtc.createOffer());
  const answer = await b.evaluate(async (code) => (window as any).node.rtc.acceptOffer(code), offer.code);
  await a.evaluate(async ([sid, code]) => (window as any).node.rtc.acceptAnswer(sid, code), [offer.sessionId, answer.code]);

  // the internet goes away; the local link stays
  await ctxA.setOffline(true);
  await ctxB.setOffline(true);

  const joined = await b.evaluate(async (url) => (window as any).node.spaces.accept(url, { timeoutMs: 30_000 }), url);
  expect(joined).toEqual({ space, role: 'viewer' });
  await b.waitForFunction(async ([noteId]) => !!(await (window as any).node.core.get(noteId)), [noteId], { timeout: 20_000 });
  const elapsed = Date.now() - started;
  expect(elapsed).toBeLessThan(60_000);
  console.log(`offline join took ${elapsed} ms`);

  // the joiner is a Viewer: it reads, and its writes are refused locally
  const refused = await b.evaluate(async (space) => {
    try {
      await (window as any).node.core.create(space, 'note', { text: 'nope' });
      return 'written';
    } catch (e: any) {
      return e.message;
    }
  }, space);
  expect(refused).toMatch(/role/);
  const approvals = await a.evaluate(() => (window as any).node.requests.length);
  expect(approvals).toBe(1);

  await ctxA.close();
  await ctxB.close();
});
