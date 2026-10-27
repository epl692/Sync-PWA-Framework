// T079 (quickstart S12, S1, SC-001): attachments between two real browsers through the relay: an offline attach, a
// placeholder first and the photo on request, the relay serving while the first browser is gone, and packets keeping
// their latency while a large blob transfers.
import { expect, test, type Browser, type Page } from '@playwright/test';

const RELAY = 'ws://localhost:8787';

async function pair(browser: Browser) {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  const id = Date.now() + Math.floor(Math.random() * 1000);
  for (const p of [a, b]) {
    await p.goto('/');
    await p.waitForFunction(() => (window as any).__sync);
  }
  await a.evaluate(async ([n, url]) => ((window as any).node = await (window as any).__sync.openSecureNode(n, { url, approve: true })), [`bo-${id}`, RELAY]);
  await b.evaluate(async ([n, url]) => ((window as any).node = await (window as any).__sync.openSecureNode(n, { url })), [`bj-${id}`, RELAY]);
  const { space, url } = await a.evaluate(async () => {
    const n = (window as any).node;
    const space = await n.spaces.create('Photos');
    const art = await n.spaces.invite(space.id, { role: 'editor', expiresAt: Date.now() + 3_600_000, maxUses: 1, approval: 'required' });
    return { space: space.id as string, url: art.url as string };
  });
  await b.evaluate(async (u) => (window as any).node.spaces.accept(u), url);
  await a.evaluate(async (name) => ((window as any).blobs = await (window as any).__sync.openBlobs((window as any).node, name)), `bo-${id}`);
  await b.evaluate(async (name) => ((window as any).blobs = await (window as any).__sync.openBlobs((window as any).node, name)), `bj-${id}`);
  for (const p of [a, b]) await waitLanePeer(p);
  return { a, b, ctxA, ctxB, space };
}

async function waitLanePeer(p: Page) {
  await p.waitForFunction(() => (window as any).node.core.peers().some((x: any) => x.lanes.length && x.spaces.includes('*')), undefined, { timeout: 30_000 });
}

/** Defined in each page: deterministic pseudo-random bytes, so the content does not compress away, and a SHA-256 helper. */
const PAGE_HELPERS = `
  window.makeBytes = (size, seed) => { const b = new Uint8Array(size); let x = seed >>> 0 || 1; for (let i = 0; i < size; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; b[i] = x & 255; } return b; };
  window.sha256Hex = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) => v.toString(16).padStart(2, '0')).join('');
`;

test('an offline attach reaches the other browser as a placeholder at once, and as the photo on request, even with the first browser gone', async ({ browser }) => {
  test.setTimeout(180_000);
  const { a, b, ctxA, ctxB, space } = await pair(browser);
  await a.evaluate(PAGE_HELPERS);
  await b.evaluate(PAGE_HELPERS);

  await ctxA.setOffline(true);
  const made = await a.evaluate(async (space) => {
    const w = window as any;
    const bytes = w.makeBytes(3 * 1024 * 1024 + 17, 42) as Uint8Array;
    const hash = await w.sha256Hex(bytes);
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase();
    const ref = await w.blobs.attach(new File([bytes as BlobPart], 'photo.png', { type: 'image/png' }), { space, obj: id });
    const note = await w.node.core.create(space, 'note', { photo: ref }, { id });
    return { ref, hash, noteId: note.id as string };
  }, space);
  await a.waitForTimeout(500);
  expect(await b.evaluate(async (id) => !!(await (window as any).node.core.get(id)), made.noteId)).toBe(false); // offline: nothing yet

  await ctxA.setOffline(false);
  await b.waitForFunction(async (id) => !!(await (window as any).node.core.get(id)), made.noteId, { timeout: 30_000 });
  // the object is there at once; the photo is only a placeholder until requested
  const status = await b.evaluate((ref) => (window as any).blobs.observe(ref).get(), made.ref);
  expect(status).toMatchObject({ state: 'missing', reason: 'not-requested', size: made.ref.size });

  // the relay stores the ciphertext in the background; once it has, the first browser can go away
  await a.waitForFunction((ref) => (window as any).blobs.observe(ref).get().replicas >= 1, made.ref, { timeout: 60_000 });
  await ctxA.setOffline(true);

  const got = await b.evaluate(async (ref) => {
    const w = window as any;
    await w.blobs.request(ref);
    const blob: Blob = await w.blobs.toBlob(ref);
    return { hash: await w.sha256Hex(new Uint8Array(await blob.arrayBuffer())), type: blob.type, size: blob.size };
  }, made.ref);
  expect(got).toEqual({ hash: made.hash, type: 'image/png', size: made.ref.size });
  await ctxA.close();
  await ctxB.close();
});

test('packets keep their latency while a large blob transfers (SC-001)', async ({ browser }) => {
  test.setTimeout(300_000);
  const { a, b, ctxA, ctxB, space } = await pair(browser);
  await a.evaluate(PAGE_HELPERS);
  await b.evaluate(() => {
    const w = window as any;
    w.arrivals = {};
    w.node.core.onApplied(({ body }: any) => {
      if (body.type === 'tick') w.arrivals[body.obj] ??= Date.now();
    });
  });

  const MB = Number(process.env.BLOB_E2E_MB ?? 40);
  const ref = await a.evaluate(
    async ([space, mb]) => {
      const w = window as any;
      const bytes = w.makeBytes(mb * 1024 * 1024, 7) as Uint8Array;
      const ref = await w.blobs.attach(new File([bytes as BlobPart], 'big.bin', { type: 'application/octet-stream' }), { space, obj: 'BIG' + Date.now() });
      await w.node.core.create(space, 'note', { big: ref });
      w.tickSpace = space;
      return ref;
    },
    [space, MB] as [string, number],
  );
  await a.waitForFunction((r) => (window as any).blobs.observe(r).get().replicas >= 1, ref, { timeout: 240_000 }); // the relay has it

  const tick = (n: number) =>
    a.evaluate(async (n) => {
      const w = window as any;
      const t0 = Date.now();
      const o = await w.node.core.create(w.tickSpace, 'tick', { n });
      return [o.id as string, t0] as [string, number];
    }, n);
  const idleSent: Array<[string, number]> = [];
  for (let i = 0; i < 30; i++) {
    idleSent.push(await tick(i));
    await a.waitForTimeout(25);
  }
  await b.waitForTimeout(500);

  await b.evaluate((ref) => void (window as any).blobs.request(ref).then(() => ((window as any).done = true)), ref);
  const duringSent: Array<[string, number]> = [];
  while (!(await b.evaluate(() => (window as any).done === true)) && duringSent.length < 3000) {
    duringSent.push(await tick(duringSent.length));
    await a.waitForTimeout(25);
  }
  await b.waitForFunction(() => (window as any).done === true, undefined, { timeout: 240_000 });
  await b.waitForTimeout(500);

  const arrivals = await b.evaluate(() => (window as any).arrivals as Record<string, number>);
  const lat = (sent: Array<[string, number]>) => sent.map(([id, t0]) => (arrivals[id] ?? Date.now() + 60_000) - t0).sort((x, y) => x - y);
  const p95 = (xs: number[]) => xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))]!;
  const idle = p95(lat(idleSent));
  const during = p95(lat(duringSent));
  console.log(`blob ${MB} MB: ${duringSent.length} packets during the transfer; p95 idle ${idle} ms, during ${during} ms (x${(during / Math.max(1, idle)).toFixed(1)})`);
  expect(duringSent.length).toBeGreaterThan(3);
  expect(during - idle).toBeLessThan(250);
  await ctxA.close();
  await ctxB.close();
});

test('attach on the phone profile (4x CPU slowdown) runs at 5 MB/s or better', async ({ page, context }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__sync);
  await page.evaluate(PAGE_HELPERS);
  const id = Date.now();
  await page.evaluate(async (n) => {
    const w = window as any;
    w.node = await w.__sync.openSecureNode(n, {});
    w.blobs = await w.__sync.openBlobs(w.node, n);
    w.space = (await w.node.spaces.create('Photos')).id;
  }, `ph-${id}`);
  const MB = Number(process.env.BLOB_PHONE_MB ?? 32);
  const bytesReady = await page.evaluate((mb) => {
    (window as any).bytes = (window as any).makeBytes(mb * 1024 * 1024, 3);
    return true;
  }, MB);
  expect(bytesReady).toBe(true);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const ms = await page.evaluate(async () => {
    const w = window as any;
    const t0 = performance.now();
    await w.blobs.attach(new File([w.bytes], 'p.bin'), { space: w.space, obj: 'PHONE' + Date.now() });
    return performance.now() - t0;
  });
  const rate = MB / (ms / 1000);
  console.log(`phone profile: attach ${MB} MB in ${ms.toFixed(0)} ms = ${rate.toFixed(1)} MB/s`);
  expect(rate).toBeGreaterThan(5);
});
