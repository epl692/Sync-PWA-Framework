// T006 (B-1, spec 004): the binary lane. Messages starting with a registered magic bypass the JSON sync decoder.
import { describe, expect, it } from 'vitest';
import { createPeers, waitFor } from '@sync/testkit';

const MAGIC = 0xb1;
const pattern = (n: number): Uint8Array => {
  const b = new Uint8Array(n);
  b[0] = MAGIC;
  for (let i = 1; i < n; i++) b[i] = i % 256;
  return b;
};

async function linked(opts: Parameters<typeof createPeers>[1] = { spaces: ['s1'] }, laneOn: Array<'a' | 'b'> = ['a', 'b']) {
  const p = await createPeers(['a', 'b'], opts);
  const lanes = Object.fromEntries(laneOn.map((n) => [n, p.core(n).lane(MAGIC)]));
  p.link('a', 'b');
  const rejected: string[] = [];
  for (const n of ['a', 'b']) p.core(n).on((e) => e.kind === 'packet:rejected' && rejected.push(`${n}:${e.reason}`));
  return { p, lanes, rejected };
}

describe('B-1 core.lane', () => {
  it('delivers a 1 MiB binary message intact (all byte values) and the JSON decoder never sees it', async () => {
    const { p, lanes, rejected } = await linked();
    const got: Uint8Array[] = [];
    lanes.b!.onMessage((peer, bytes) => {
      expect(peer).toBe('memory:a');
      got.push(bytes);
    });
    await waitFor(() => lanes.a!.peers().length === 1, 3000, 'lane peer');
    const msg = pattern(1024 * 1024);
    await lanes.a!.send(lanes.a!.peers()[0]!.key, msg);
    await waitFor(() => got.length === 1, 3000, 'delivery');
    expect(got[0]!.length).toBe(msg.length);
    expect(got[0]!.every((v, i) => v === msg[i])).toBe(true);
    expect(rejected).toEqual([]);
    expect(p.core('a').peers()).toHaveLength(1);
  });

  it('advertises lanes in hello', async () => {
    const p = await createPeers(['a', 'b'], { spaces: ['s1'] });
    const hellos: string[] = [];
    p.net.tap((from, _to, bytes) => from === 'a' && hellos.push(new TextDecoder().decode(bytes)));
    p.core('a').lane(MAGIC);
    p.link('a', 'b');
    await waitFor(() => hellos.some((h) => h.includes('"t":"hello"') && h.includes(`"lanes":[${MAGIC}]`)), 3000, 'hello with lanes');
  });

  it('lists only peers that advertised the lane and never sends them lane bytes', async () => {
    const { p, lanes } = await linked({ spaces: ['s1'] }, ['a']);
    await waitFor(() => p.core('a').peers().length === 1, 3000, 'peer');
    await new Promise((r) => setTimeout(r, 50));
    expect(lanes.a!.peers()).toEqual([]);
    const seen: number[] = [];
    p.net.tap((_f, _t, bytes) => seen.push(bytes[0]!));
    await expect(lanes.a!.send('memory:b', pattern(10))).rejects.toThrow(/lane/);
    expect(seen.filter((b) => b >= 0x80)).toEqual([]);
  });

  it('refuses a second registration of one magic and magics below 0x80', async () => {
    const p = await createPeers(['a']);
    p.core('a').lane(MAGIC);
    expect(() => p.core('a').lane(MAGIC)).toThrow();
    expect(() => p.core('a').lane(0x7b)).toThrow();
    expect(() => p.core('a').lane(0x100)).toThrow();
  });

  it('reports a stray lane byte at a core without the lane and stays connected', async () => {
    const { p, rejected } = await linked({ spaces: ['s1'] }, ['a']);
    await waitFor(() => p.core('a').peers().length === 1, 3000, 'peer');
    await p.net.transport('a').send('b', pattern(100));
    await waitFor(() => rejected.some((r) => r.startsWith('b:') && /lane/.test(r)), 3000, 'report');
    await p.core('a').create('s1', 'note', { x: 1 });
    await waitFor(async () => (await p.core('b').query({ type: 'note' }).once()).length === 1, 3000, 'packet sync still works');
  });

  it('drops and reports a lane message over limits.maxMessageBytes and keeps the connection', async () => {
    const { lanes, rejected } = await linked({ spaces: ['s1'], limits: { maxMessageBytes: 4096 } });
    const got: number[] = [];
    lanes.b!.onMessage((_p, b) => got.push(b.length));
    await waitFor(() => lanes.a!.peers().length === 1, 3000, 'lane peer');
    const key = lanes.a!.peers()[0]!.key;
    await lanes.a!.send(key, pattern(5000));
    await lanes.a!.send(key, pattern(100));
    await waitFor(() => got.length === 1, 3000, 'small message');
    expect(got).toEqual([100]);
    expect(rejected.some((r) => /too large/.test(r))).toBe(true);
  });

  it('only accepts bytes that start with the lane magic', async () => {
    const { lanes } = await linked();
    await waitFor(() => lanes.a!.peers().length === 1, 3000, 'lane peer');
    await expect(lanes.a!.send(lanes.a!.peers()[0]!.key, new Uint8Array([0x01, 2, 3]))).rejects.toThrow(/magic/);
  });
});

describe('B-1 lane peers across reconnects', () => {
  it('reports a disconnect (and the next connect) for a peer that was already a lane peer when the lane was registered', async () => {
    const p = await createPeers(['a', 'b'], { spaces: ['s1'] });
    p.core('b').lane(MAGIC); // b registers first, so a's hello already names the lane when a registers later
    p.link('a', 'b');
    await waitFor(() => p.core('a').peers().some((x) => x.spaces.length), 5000, 'connected');
    const la = p.core('a').lane(MAGIC); // registered after the peer was connected
    await waitFor(() => la.peers().length === 1, 5000, 'lane peer');
    const events: string[] = [];
    la.onPeer((e) => events.push(e.type));
    p.net.sever('a', 'b');
    await waitFor(() => events.includes('down'), 5000, 'down');
    p.net.restore('a', 'b');
    await waitFor(() => events.includes('up'), 5000, 'up again');
    expect(events).toEqual(['down', 'up']);
  });
});
