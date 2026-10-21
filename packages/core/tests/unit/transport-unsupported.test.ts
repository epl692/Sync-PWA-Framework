// T074 (Story 4 scenario 4): an unsupported transport reports itself and the app continues on the others.
import { describe, expect, it } from 'vitest';
import { createPeers, unsupportedTransport, waitFor } from '@sync/testkit';

describe('unsupported transports', () => {
  it('reports unsupported, never starts, and does not affect sync over other transports', async () => {
    const p = await createPeers(['a', 'b'], { spaces: ['s1'] });
    const states: string[] = [];
    p.core('a').on((e) => e.kind === 'transport:state' && states.push(`${e.transport}:${e.state}`));
    p.core('a').addTransport(unsupportedTransport('webrtc', 'RTCPeerConnection is not available'));
    p.link('a', 'b', 'ws');

    expect(states).toContain('webrtc:unsupported');
    expect(p.core('a').transports()).toContainEqual({ id: 'webrtc', state: 'idle' });

    const o = await p.core('a').create('s1', 'note', { t: 'still syncing' });
    await waitFor(async () => !!(await p.core('b').get(o.id)), 3000, 'sync over the working transport');
  });

  it('can be removed again without error', async () => {
    const p = await createPeers(['a'], { spaces: ['s1'] });
    p.core('a').addTransport(unsupportedTransport('webrtc'));
    await p.core('a').removeTransport('webrtc');
    expect(p.core('a').transports()).toEqual([]);
  });
});
