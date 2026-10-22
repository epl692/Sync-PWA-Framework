// T009 (A-4): plugin message channel. Never persisted by the core.
import { describe, expect, it } from 'vitest';
import { createPeers, readPacketRecords, waitFor } from '@sync/testkit';

const text = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);

describe('A-4 core.channel', () => {
  it('delivers payloads between linked peers by peer key and by broadcast, and persists nothing', async () => {
    const p = await createPeers(['a', 'b'], { spaces: ['s1'] });
    p.link('a', 'b');
    const got: string[] = [];
    p.core('a').channel('identity/1').onMessage((peer, payload) => {
      expect(peer).toBe('memory:b');
      got.push(str(payload));
    });
    const onB = p.core('b').channel('identity/1');
    await waitFor(() => p.core('b').peers().length > 0, 3000, 'peer');
    await onB.send(p.core('b').peers()[0]!.key, text('hello'));
    await onB.broadcast(text('again'));
    await waitFor(() => got.length === 2, 3000, 'messages');
    expect(got).toEqual(['hello', 'again']);
    expect(await readPacketRecords(p.peers.a!.storage)).toHaveLength(0);
  });

  it('keeps channels separate by name and ignores unknown channels', async () => {
    const p = await createPeers(['a', 'b'], { spaces: ['s1'] });
    p.link('a', 'b');
    const other: string[] = [];
    p.core('a').channel('other/1').onMessage((_p, b) => other.push(str(b)));
    await waitFor(() => p.core('b').peers().length > 0, 3000, 'peer');
    await p.core('b').channel('identity/1').broadcast(text('x'));
    await p.core('b').channel('other/1').broadcast(text('y'));
    await waitFor(() => other.length === 1, 3000, 'other');
    expect(other).toEqual(['y']);
  });

  it('setRoutes adds Spaces to the hello so a device with no data can be routed to', async () => {
    const p = await createPeers(['a', 'b']);
    const hellos: string[] = [];
    p.net.tap((from, _to, bytes) => from === 'b' && hellos.push(new TextDecoder().decode(bytes)));
    p.core('b').channel('identity/1').setRoutes(['join-space']);
    p.link('a', 'b');
    await waitFor(() => hellos.some((h) => h.includes('join-space')), 3000, 'hello with route');
  });
});
