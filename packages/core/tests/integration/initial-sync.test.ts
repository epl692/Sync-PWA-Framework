// T044: large initial sync (bounded batches, progress, yielding) and a corrupt packet rejected alone.
import { describe, expect, it } from 'vitest';
import { b64urlEncode, decodeMessage, encodeMessage, type CoreEvent, type Msg } from '@sync/core';
import { MemoryNetwork, createPeers, createTestCore, remoteEnvelope, waitFor } from '@sync/testkit';

describe('initial sync', () => {
  it('moves 1,200 packets in batches of at most 500 and reports progress', async () => {
    const p = await createPeers(['a', 'b'], { spaces: ['s1'] });
    for (let i = 0; i < 1200; i++) await p.core('a').create('s1', 'item', { i });

    const sizes: number[] = [];
    p.net.tap((from, _to, bytes) => {
      const d = decodeMessage(bytes);
      if (from === 'a' && d.ok && 'msg' in d && d.msg.t === 'packets') sizes.push(d.msg.items.length);
    });
    const progress: Extract<CoreEvent, { kind: 'sync:progress' }>[] = [];
    p.core('b').on((e) => e.kind === 'sync:progress' && progress.push(e));

    p.link('a', 'b');
    await p.converged('s1', ['a', 'b'], 30_000);

    expect(Math.max(...sizes)).toBeLessThanOrEqual(500);
    expect(sizes.length).toBeGreaterThanOrEqual(3);
    expect(progress.length).toBeGreaterThan(1);
    const last = progress[progress.length - 1]!;
    expect(last.received).toBe(1200);
    expect(last.total).toBe(1200);
    expect(await p.core('b').query({ type: 'item' }).once()).toHaveLength(1200);
  }, 60_000);

  it('rejects a corrupt packet on its own and applies the rest of the batch', async () => {
    const net = new MemoryNetwork();
    const t = await createTestCore({ spaces: ['s1'] });
    t.core.addTransport(net.transport('core'));
    const fake = net.transport('fake');
    await fake.start();
    net.link('core', 'fake');
    const rejected: string[] = [];
    t.core.on((e) => e.kind === 'packet:rejected' && rejected.push(e.reason));

    const good1 = await remoteEnvelope({ obj: 'o1', op: 'create', type: 't', fields: { a: 1 } }, { author: 'PEERAAAA', seq: 1 });
    const good2 = await remoteEnvelope({ obj: 'o2', op: 'create', type: 't', fields: { a: 2 } }, { author: 'PEERAAAA', seq: 2 });
    const truncated = good1.raw.slice(0, 20);
    await waitFor(() => true);
    await new Promise((r) => setTimeout(r, 30));
    await fake.send('core', encodeMessage({ t: 'hello', protocol: { min: 1, max: 1 }, device: 'PEERAAAA', spaces: ['s1'], relay: true } as Msg));
    await new Promise((r) => setTimeout(r, 30));
    await fake.send(
      'core',
      encodeMessage({ t: 'packets', space: 's1', items: [b64urlEncode(good1.raw), b64urlEncode(truncated), 'not*base64', b64urlEncode(good2.raw)] }),
    );
    await waitFor(async () => (await t.core.get('o2')) !== undefined, 3000, 'good packets applied');
    expect(await t.core.get('o1')).toBeDefined();
    expect(rejected.length).toBeGreaterThanOrEqual(2);
  });
});
