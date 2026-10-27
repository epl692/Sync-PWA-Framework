// T008 (B-2, spec 004): peer summaries carry what the blob scheduler needs, and peer:ready / peer:gone events.
import { describe, expect, it } from 'vitest';
import { encodeMessage } from '@sync/core';
import { createPeers, waitFor } from '@sync/testkit';

describe('B-2 PeerSummary', () => {
  it('keeps key, transport, peerId, label and gains spaces, relay, maxMessageBytes, bulk', async () => {
    const p = await createPeers(['a', 'b'], { spaces: ['s1'] });
    p.link('a', 'b');
    const peer = await waitFor(() => p.core('a').peers().find((x) => x.spaces.includes('s1')), 3000, 'ready peer');
    expect(peer).toMatchObject({ key: 'memory:b', transport: 'memory', peerId: 'b', label: 'b', relay: true, bulk: false });
    expect(peer.maxMessageBytes).toBe(64 * 1024 * 1024);
  });

  it('fires peer:ready after hello and peer:gone on disconnect', async () => {
    const p = await createPeers(['a', 'b'], { spaces: ['s1'] });
    const ev: string[] = [];
    p.core('a').on((e) => (e.kind === 'peer:ready' || e.kind === 'peer:gone') && ev.push(`${e.kind}:${e.peer.key}`));
    p.link('a', 'b');
    await waitFor(() => ev.includes('peer:ready:memory:b'), 3000, 'ready');
    expect(ev).toEqual(['peer:ready:memory:b']);
    p.net.sever('a', 'b');
    await waitFor(() => ev.includes('peer:gone:memory:b'), 3000, 'gone');
  });

  it('reports a relay wildcard Space as ["*"]', async () => {
    const p = await createPeers(['a', 'b'], { spaces: ['s1'] });
    p.link('a', 'b'); // attaches the memory transport to a
    const r = p.net.transport('r');
    await r.start();
    p.net.link('a', 'r');
    await r.send('a', encodeMessage({ t: 'hello', protocol: { min: 1, max: 1 }, device: 'relay', spaces: ['*'], relay: true }));
    const peer = await waitFor(() => p.core('a').peers().find((x) => x.peerId === 'r' && x.spaces.length), 3000, 'relay peer');
    expect(peer.spaces).toEqual(['*']);
    expect(peer.relay).toBe(true);
  });

  it('updates the entry when the peer announces a new Space', async () => {
    const p = await createPeers(['a', 'b'], { spaces: ['s1'] });
    p.link('a', 'b');
    await waitFor(() => p.core('a').peers()[0]?.spaces.includes('s1'), 3000, 'ready');
    await p.core('b').create('s9', 'note', { x: 1 });
    await waitFor(() => p.core('a').peers()[0]?.spaces.includes('s9'), 3000, 'new space');
  });
});
