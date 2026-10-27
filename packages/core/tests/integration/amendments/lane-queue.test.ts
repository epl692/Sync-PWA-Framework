// T007 (B-1): lane sends do not share the per-peer packet queue. Real (short) timers stand in for the fake clock: the
// transport makes every lane write slow, as a congested bulk write would be, and packets must not wait behind it.
import { describe, expect, it } from 'vitest';
import { createPeers, waitFor } from '@sync/testkit';

const MAGIC = 0xb1;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('B-1 lane and packet queues are independent', () => {
  it('delivers a packet while slow lane messages are still being written', async () => {
    const p = await createPeers(['a', 'b'], { spaces: ['s1'] });
    const ta = p.net.transport('a');
    const orig = ta.send.bind(ta);
    ta.send = async (peer, bytes) => {
      if (bytes[0]! >= 0x80) await sleep(400);
      return orig(peer, bytes);
    };
    const la = p.core('a').lane(MAGIC);
    p.core('b').lane(MAGIC);
    p.link('a', 'b');
    await waitFor(() => la.peers().length === 1, 3000, 'lane peer');
    await p.core('a').create('s1', 'note', { warm: 1 });
    await waitFor(async () => (await p.core('b').query({ type: 'note' }).once()).length === 1, 3000, 'warm-up sync');

    const msg = new Uint8Array(256 * 1024);
    msg[0] = MAGIC;
    const sends = Array.from({ length: 5 }, () => la.send(la.peers()[0]!.key, msg));
    const t0 = Date.now();
    await p.core('a').create('s1', 'note', { x: 2 });
    await waitFor(async () => (await p.core('b').query({ type: 'note' }).once()).length === 2, 3000, 'packet');
    expect(Date.now() - t0).toBeLessThan(300); // the five lane writes take about 400 ms in parallel; a shared queue would take 2 s
    await Promise.all(sends);
  });
});
