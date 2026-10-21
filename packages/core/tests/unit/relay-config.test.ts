// T069 (FR-015): relay is configurable per app and per Space.
import { describe, expect, it } from 'vitest';
import { createPeers, waitFor } from '@sync/testkit';

const settle = () => new Promise((r) => setTimeout(r, 120));

describe('relay configuration', () => {
  it('forwards by default', async () => {
    const p = await createPeers(['a', 'b', 'c'], { spaces: ['s1'] });
    p.link('a', 'b');
    p.link('b', 'c');
    const o = await p.core('a').create('s1', 'note', {});
    await waitFor(async () => !!(await p.core('c').get(o.id)), 3000, 'relay');
  });

  it('with relay off, a device keeps what it receives but forwards only its own packets', async () => {
    const p = await createPeers(['a', 'b', 'c'], { spaces: ['s1'], relay: false });
    p.link('a', 'b');
    p.link('b', 'c');
    const fromA = await p.core('a').create('s1', 'note', { who: 'a' });
    await settle();
    expect(await p.core('b').get(fromA.id)).toBeDefined();
    expect(await p.core('c').get(fromA.id)).toBeUndefined(); // b did not relay a's packet, live or by catch-up

    const fromB = await p.core('b').create('s1', 'note', { who: 'b' });
    await waitFor(async () => !!(await p.core('c').get(fromB.id)), 3000, "b's own packet reaches c");
  });

  it('with relay off, a later-joining peer is not sent third-party packets either', async () => {
    const p = await createPeers(['a', 'b', 'c'], { spaces: ['s1'], relay: false });
    p.link('a', 'b');
    const o = await p.core('a').create('s1', 'note', {});
    await waitFor(async () => !!(await p.core('b').get(o.id)), 3000, 'a to b');
    p.link('b', 'c'); // c connects after the fact: summary exchange must not leak a's packet via b
    await settle();
    expect(await p.core('c').get(o.id)).toBeUndefined();
  });

  it('can be set per Space', async () => {
    const p = await createPeers(['a', 'b', 'c'], { spaces: ['open', 'closed'], relay: { open: true, closed: false } });
    p.link('a', 'b');
    p.link('b', 'c');
    const open = await p.core('a').create('open', 'note', {});
    const closed = await p.core('a').create('closed', 'note', {});
    await waitFor(async () => !!(await p.core('c').get(open.id)), 3000, 'open space relays');
    await settle();
    expect(await p.core('b').get(closed.id)).toBeDefined();
    expect(await p.core('c').get(closed.id)).toBeUndefined();
  });
});
