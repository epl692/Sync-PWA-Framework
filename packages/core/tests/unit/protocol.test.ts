// T042: sync protocol behaviour, driven by a scripted fake peer speaking raw protocol messages.
import { describe, expect, it } from 'vitest';
import { b64urlDecode, decodeMessage, encodeMessage, type Msg } from '@sync/core';
import { MemoryNetwork, createPeers, createTestCore, remoteEnvelope, waitFor } from '@sync/testkit';

/** A fake peer attached to a real core over the in-memory network. */
async function scripted(opts: { seed?: (core: Awaited<ReturnType<typeof createTestCore>>['core']) => Promise<void>; batch?: { packets: number } } = {}) {
  const net = new MemoryNetwork();
  const t = await createTestCore({ batch: opts.batch as never, spaces: ['s1'] });
  await opts.seed?.(t.core);
  t.core.addTransport(net.transport('core'));
  const fake = net.transport('fake');
  const got: Msg[] = [];
  fake.on('message', (_p, b) => {
    const d = decodeMessage(b);
    if (d.ok && 'msg' in d) got.push(d.msg);
  });
  await fake.start();
  net.link('core', 'fake');
  await waitFor(() => got.some((m) => m.t === 'hello'), 3000, 'core hello');
  const send = (m: Msg) => fake.send('core', encodeMessage(m));
  const hello = (spaces: string[] = ['s1'], protocol = { min: 1, max: 1 }) => send({ t: 'hello', protocol, device: 'FAKEPEER', spaces, relay: true });
  return { t, net, got, send, hello, ofType: <T extends Msg['t']>(k: T) => got.filter((m) => m.t === k) as Extract<Msg, { t: T }>[] };
}

const seedThree = async (core: { create: (...a: any[]) => Promise<unknown> }) => {
  for (let i = 0; i < 3; i++) await core.create('s1', 'note', { i });
};

describe('sync protocol', () => {
  it('announces its protocol range and Spaces in hello', async () => {
    const p = await scripted();
    const hello = p.ofType('hello')[0]!;
    expect(hello.protocol).toEqual({ min: 1, max: 1 });
    expect(hello.spaces).toEqual(['s1']);
  });

  it('fails fatally when the protocol ranges do not overlap', async () => {
    const p = await scripted();
    await p.hello(['s1'], { min: 2, max: 3 });
    const err = await waitFor(() => p.ofType('error')[0], 3000, 'error message');
    expect(err).toMatchObject({ code: 'protocol-mismatch', fatal: true });
    expect(p.ofType('summary')).toHaveLength(0);
  });

  it('sends a summary for each shared Space after hello', async () => {
    const p = await scripted({ seed: seedThree });
    await p.hello();
    const s = await waitFor(() => p.ofType('summary')[0], 3000, 'summary');
    expect(s.space).toBe('s1');
    expect(Object.values(s.held).flat()).toEqual([[1, 3]]);
  });

  it('answers an empty peer summary with every packet it holds', async () => {
    const p = await scripted({ seed: seedThree });
    await p.hello();
    await p.send({ t: 'summary', space: 's1', held: {} });
    const pk = await waitFor(() => p.ofType('packets')[0], 3000, 'packets');
    expect(pk.items).toHaveLength(3);
  });

  it('sends only the packets the peer is missing (resumable sync)', async () => {
    const p = await scripted({ seed: seedThree });
    await p.hello();
    const mine = await waitFor(() => p.ofType('summary')[0], 3000, 'summary');
    const author = Object.keys(mine.held)[0]!;
    await p.send({ t: 'summary', space: 's1', held: { [author]: [[1, 2]] } });
    const pk = await waitFor(() => p.ofType('packets')[0], 3000, 'packets');
    expect(pk.items).toHaveLength(1);
    const env = JSON.parse(new TextDecoder().decode(b64urlDecode(pk.items[0]!)));
    expect(env.id).toBe(`${author}:3`);
  });

  it('sends nothing when the peer already holds everything', async () => {
    const p = await scripted({ seed: seedThree });
    await p.hello();
    const mine = await waitFor(() => p.ofType('summary')[0], 3000, 'summary');
    await p.send({ t: 'summary', space: 's1', held: mine.held });
    await new Promise((r) => setTimeout(r, 60));
    expect(p.ofType('packets')).toHaveLength(0);
  });

  it('answers a want with exactly the requested range', async () => {
    const p = await scripted({ seed: seedThree });
    await p.hello();
    const mine = await waitFor(() => p.ofType('summary')[0], 3000, 'summary');
    const author = Object.keys(mine.held)[0]!;
    await p.send({ t: 'summary', space: 's1', held: mine.held });
    await p.send({ t: 'want', space: 's1', ranges: { [author]: [[2, 2]] } });
    const pk = await waitFor(() => p.ofType('packets')[0], 3000, 'packets');
    expect(pk.items).toHaveLength(1);
  });

  it('applies received packets and acks their ids', async () => {
    const p = await scripted();
    await p.hello();
    const e = await remoteEnvelope({ obj: 'o1', op: 'create', type: 't', fields: { a: 1 } }, { author: 'FAKEPEER', seq: 1 });
    await p.send({ t: 'packets', space: 's1', items: [btoa(String.fromCharCode(...e.raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')] });
    const ack = await waitFor(() => p.ofType('ack')[0], 3000, 'ack');
    expect(ack.ids).toEqual([e.env.id]);
    expect(await p.t.core.get('o1')).toBeDefined();
  });

  it('ignores unknown message types and keeps working', async () => {
    const p = await scripted({ seed: seedThree });
    await p.hello();
    await p.send({ t: 'from-the-future', x: 1 } as unknown as Msg);
    await p.send({ t: 'summary', space: 's1', held: {} });
    expect((await waitFor(() => p.ofType('packets')[0], 3000, 'packets')).items).toHaveLength(3);
  });

  it('ignores Spaces that are not shared', async () => {
    const p = await scripted({ seed: seedThree });
    await p.hello(['other']);
    await new Promise((r) => setTimeout(r, 60));
    expect(p.ofType('summary')).toHaveLength(0);
    await p.send({ t: 'summary', space: 's1', held: {} });
    await new Promise((r) => setTimeout(r, 60));
    expect(p.ofType('packets')).toHaveLength(0);
  });

  it('after a drop, a reconnect sends only what the peer is still missing', async () => {
    const { net, core } = await createPeers(['a', 'b'], { spaces: ['s1'], batch: { packets: 10 } as never }).then(async (p) => {
      for (let i = 0; i < 40; i++) await p.core('a').create('s1', 'note', { i });
      return { net: p.net, core: p, };
    });
    let delivered = 0;
    let cut = false;
    net.tap((from, to, bytes) => {
      const d = decodeMessage(bytes);
      if (from === 'a' && d.ok && 'msg' in d && d.msg.t === 'packets') {
        delivered += d.msg.items.length;
        if (!cut && delivered >= 10) {
          cut = true;
          queueMicrotask(() => net.sever('a', 'b'));
        }
      }
    });
    core.link('a', 'b');
    await waitFor(() => cut, 5000, 'first batch');
    await new Promise((r) => setTimeout(r, 30));
    const before = delivered;
    const have = (await core.core('b').query({ type: 'note' }).once()).length;
    expect(have).toBeLessThan(40);
    net.restore('a', 'b');
    await core.converged('s1');
    expect(await core.core('b').query({ type: 'note' }).once()).toHaveLength(40);
    expect(delivered - before).toBeLessThanOrEqual(40 - have + 10); // only the missing packets (plus at most one in-flight batch)
  });
});
