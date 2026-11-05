// A "syncing (n)" indicator needs to know how many of this device's own changes no peer has confirmed yet.
import { describe, expect, it } from 'vitest';
import { MemoryNetwork, createPeers, createTestCore, waitFor } from '@sync/testkit';

describe('unconfirmed(): changes written here that no peer has acknowledged', () => {
  it('counts every write while offline, and is empty on a fresh device', async () => {
    const t = await createTestCore();
    expect(await t.core.unconfirmed()).toEqual({ count: 0 });
    for (let i = 0; i < 4; i++) await t.core.create('s1', 'note', { i });
    const u = await t.core.unconfirmed();
    expect(u.count).toBe(4);
    expect(typeof u.oldestAt).toBe('number'); // when the oldest unconfirmed change was written (the core's clock)
  });

  it('survives a restart: what was never confirmed is still counted', async () => {
    const t = await createTestCore();
    await t.core.create('s1', 'note', { t: 'x' });
    const again = await t.reopen();
    expect((await again.unconfirmed()).count).toBe(1);
  });

  it('falls to zero once a peer has acknowledged everything, and counts a new write until it is acknowledged', async () => {
    const net = new MemoryNetwork({ autoDeliver: false }); // messages wait until flushed, so "sent but not acknowledged" can be looked at
    const p = await createPeers(['a', 'b'], { spaces: ['s1'] }, net);
    for (let i = 0; i < 3; i++) await p.core('a').create('s1', 'note', { i });
    expect((await p.core('a').unconfirmed()).count).toBe(3);

    p.link('a', 'b');
    for (let i = 0; i < 30; i++) {
      net.flush();
      await new Promise((r) => setTimeout(r, 5));
    }
    await waitFor(async () => (await p.core('a').unconfirmed()).count === 0, 5000, 'b acknowledged everything');
    expect(await p.core('b').query({ type: 'note' }).once()).toHaveLength(3);

    await p.core('a').create('s1', 'note', { t: 'later' });
    expect((await p.core('a').unconfirmed()).count).toBe(1); // written, forwarded, not yet acknowledged
    for (let i = 0; i < 30; i++) {
      net.flush();
      await new Promise((r) => setTimeout(r, 5));
    }
    await waitFor(async () => (await p.core('a').unconfirmed()).count === 0, 5000, 'acknowledged');
  });

  it('only the writer counts it: the peer that merely received a change has nothing unconfirmed', async () => {
    const p = await createPeers(['a', 'b'], { spaces: ['s1'] });
    p.link('a', 'b');
    await p.core('a').create('s1', 'note', { t: 'from a' });
    await p.converged('s1');
    expect((await p.core('b').unconfirmed()).count).toBe(0);
    await waitFor(async () => (await p.core('a').unconfirmed()).count === 0, 5000, 'a confirmed');
  });
});
