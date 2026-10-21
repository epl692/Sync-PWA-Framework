// T068 (Story 4): several transports at once, dedup by id, relay between transports, no relay loops.
import { describe, expect, it } from 'vitest';
import { decodeMessage } from '@sync/core';
import { createPeers, flush, waitFor } from '@sync/testkit';

describe('Story 4: simultaneous transports', () => {
  it('applies a packet once when it arrives on two transports (scenario 1)', async () => {
    const p = await createPeers(['a', 'b'], { spaces: ['s1'] });
    p.link('a', 'b', 'ws');
    p.link('a', 'b', 'rtc');
    let emits = 0;
    p.core('b').query({ type: 'note' }).subscribe(() => emits++);
    await waitFor(() => p.core('b').transports().length === 2, 2000, 'both transports on b');
    await p.core('a').create('s1', 'note', { t: 'once' });
    await p.converged('s1');
    await flush();
    await new Promise((r) => setTimeout(r, 50));
    expect(await p.core('b').query({ type: 'note' }).once()).toHaveLength(1);
    expect(emits).toBe(2); // initial result, then exactly one change
  });

  it('relays a write from A (WebSocket only) through B (both) to C (WebRTC only) (scenario 2)', async () => {
    const p = await createPeers(['a', 'b', 'c'], { spaces: ['s1'] });
    p.link('a', 'b', 'ws');
    p.link('b', 'c', 'rtc');
    const o = await p.core('a').create('s1', 'note', { t: 'hello c' });
    await waitFor(async () => !!(await p.core('c').get(o.id)), 3000, 'packet to reach c');
    // and live edits keep flowing the whole way
    await p.core('a').update(o.id, { t: 'edited' });
    await waitFor(async () => (await p.core('c').get(o.id))?.fields.t === 'edited', 3000, 'live relay to c');
  });

  it('carries a write in the other direction too (C to A)', async () => {
    const p = await createPeers(['a', 'b', 'c'], { spaces: ['s1'] });
    p.link('a', 'b', 'ws');
    p.link('b', 'c', 'rtc');
    const o = await p.core('c').create('s1', 'note', { t: 'from c' });
    await waitFor(async () => !!(await p.core('a').get(o.id)), 3000, 'packet to reach a');
  });

  it('stops a relay ring A to B to C to A: every packet crosses each link at most once', async () => {
    const p = await createPeers(['a', 'b', 'c'], { spaces: ['s1'] });
    const sent = new Map<string, number>(); // "from>to:packetId" -> times sent
    p.net.tap((from, to, bytes) => {
      const d = decodeMessage(bytes);
      if (d.ok && 'msg' in d && d.msg.t === 'packets') {
        for (const item of d.msg.items) {
          const id = JSON.parse(atob(item.replace(/-/g, '+').replace(/_/g, '/'))).id as string;
          const k = `${from}>${to}:${id}`;
          sent.set(k, (sent.get(k) ?? 0) + 1);
        }
      }
    });
    p.link('a', 'b');
    p.link('b', 'c');
    p.link('c', 'a');
    const o = await p.core('a').create('s1', 'note', { t: 'ring' });
    await p.converged('s1');
    await new Promise((r) => setTimeout(r, 100));
    const before = [...sent.values()].reduce((x, y) => x + y, 0);
    await new Promise((r) => setTimeout(r, 150));
    expect([...sent.values()].reduce((x, y) => x + y, 0)).toBe(before); // nothing keeps bouncing
    for (const [k, n] of sent) expect(n, k).toBe(1);
    expect(await p.core('c').get(o.id)).toBeDefined();
  });

  it('keeps syncing over the remaining transport when one drops mid-session (scenario 3)', async () => {
    const p = await createPeers(['a', 'b'], { spaces: ['s1'] });
    p.link('a', 'b', 'ws');
    p.link('a', 'b', 'rtc');
    await p.core('a').create('s1', 'note', { t: 'one' });
    await p.converged('s1');
    p.net.sever('a', 'b', 'ws');
    const two = await p.core('a').create('s1', 'note', { t: 'two' });
    await waitFor(async () => !!(await p.core('b').get(two.id)), 3000, 'delivery over rtc');
    p.net.restore('a', 'b', 'ws');
    await p.converged('s1');
  });

  it('lets a transport be added and removed at runtime', async () => {
    const p = await createPeers(['a', 'b'], { spaces: ['s1'] });
    p.link('a', 'b', 'ws');
    expect(p.core('a').transports().map((t) => t.id)).toEqual(['ws']);
    await p.core('a').removeTransport('ws');
    expect(p.core('a').transports()).toEqual([]);
    const o = await p.core('a').create('s1', 'note', { t: 'offline now' });
    await new Promise((r) => setTimeout(r, 50));
    expect(await p.core('b').get(o.id)).toBeUndefined();
  });
});
