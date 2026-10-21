// T046: the hub stores and forwards opaque packets without ever decoding bodies.
import { describe, expect, it } from 'vitest';
import { ANY_SPACE, b64urlEncode, decodeMessage, encodeMessage, type Msg } from '@sync/core';
import { remoteEnvelope } from '@sync/testkit';
import { RelayHub } from '../src/relayHub';

function harness() {
  const inbox = new Map<string, Msg[]>();
  const hub = new RelayHub((peer, bytes) => {
    const d = decodeMessage(bytes);
    if (d.ok && 'msg' in d) (inbox.get(peer) ?? inbox.set(peer, []).get(peer)!).push(d.msg);
  });
  const connect = (id: string) => {
    hub.onConnect(id);
    return {
      send: (m: Msg) => hub.onMessage(id, encodeMessage(m)),
      got: <T extends Msg['t']>(t: T) => (inbox.get(id) ?? []).filter((m) => m.t === t) as Extract<Msg, { t: T }>[],
    };
  };
  return { hub, connect, inbox };
}

const hello = (spaces: string[]): Msg => ({ t: 'hello', protocol: { min: 1, max: 1 }, device: 'D', spaces, relay: true });

describe('RelayHub', () => {
  it('greets with hello offering any Space, and accepts a peer protocol range', () => {
    const { connect } = harness();
    const a = connect('a');
    a.send(hello(['s1']));
    const h = a.got('hello')[0]!;
    expect(h.spaces).toEqual([ANY_SPACE]);
    expect(a.got('summary').map((s) => s.space)).toEqual(['s1']);
  });

  it('stores packets from one peer and serves them to a later peer', async () => {
    const { connect } = harness();
    const a = connect('a');
    a.send(hello(['s1']));
    const e1 = await remoteEnvelope({ obj: 'o1', op: 'create', type: 't', fields: { a: 1 } }, { author: 'AUTH', seq: 1 });
    const e2 = await remoteEnvelope({ obj: 'o2', op: 'create', type: 't', fields: { a: 2 } }, { author: 'AUTH', seq: 2 });
    a.send({ t: 'packets', space: 's1', items: [b64urlEncode(e1.raw), b64urlEncode(e2.raw)] });
    expect(a.got('ack')[0]!.ids).toEqual(['AUTH:1', 'AUTH:2']);

    const b = connect('b');
    b.send(hello(['s1']));
    b.send({ t: 'summary', space: 's1', held: {} });
    expect(b.got('packets').flatMap((p) => p.items)).toHaveLength(2);
    const summary = b.got('summary')[0]!;
    expect(summary.held).toEqual({ AUTH: [[1, 2]] });
  });

  it('forwards live packets to other peers of the Space but not back to the sender', async () => {
    const { connect } = harness();
    const a = connect('a');
    const b = connect('b');
    const c = connect('c');
    a.send(hello(['s1']));
    b.send(hello(['s1']));
    c.send(hello(['other']));
    const e = await remoteEnvelope({ obj: 'o1', op: 'create', type: 't', fields: {} }, { author: 'AUTH', seq: 1 });
    a.send({ t: 'packets', space: 's1', items: [b64urlEncode(e.raw)] });
    expect(b.got('packets').flatMap((p) => p.items)).toHaveLength(1);
    expect(a.got('packets')).toHaveLength(0);
    expect(c.got('packets')).toHaveLength(0);
  });

  it('forwards packets it cannot decode: unknown codec and unknown envelope version', async () => {
    const { connect } = harness();
    const a = connect('a');
    const b = connect('b');
    a.send(hello(['s1']));
    b.send(hello(['s1']));
    const opaque = await remoteEnvelope({ obj: 'o', op: 'create', type: 't', fields: {} }, { author: 'AUTH', seq: 1, codecId: 'secret-cipher/9' });
    a.send({ t: 'packets', space: 's1', items: [b64urlEncode(opaque.raw)] });
    const newer = new TextEncoder().encode(JSON.stringify({ v: 9, id: 'AUTH:2', author: 'AUTH', seq: 2, space: 's1', future: true }));
    a.send({ t: 'packets', space: 's1', items: [b64urlEncode(newer)] });
    expect(b.got('packets').flatMap((p) => p.items)).toHaveLength(2);
  });

  it('is idempotent: a duplicate is acked but not forwarded twice', async () => {
    const { connect } = harness();
    const a = connect('a');
    const b = connect('b');
    a.send(hello(['s1']));
    b.send(hello(['s1']));
    const e = await remoteEnvelope({ obj: 'o1', op: 'create', type: 't', fields: {} }, { author: 'AUTH', seq: 1 });
    a.send({ t: 'packets', space: 's1', items: [b64urlEncode(e.raw)] });
    a.send({ t: 'packets', space: 's1', items: [b64urlEncode(e.raw)] });
    expect(b.got('packets')).toHaveLength(1);
    expect(a.got('ack')).toHaveLength(2);
  });

  it('rejects garbage items without disturbing the rest of the batch', async () => {
    const { connect } = harness();
    const a = connect('a');
    a.send(hello(['s1']));
    const good = await remoteEnvelope({ obj: 'o1', op: 'create', type: 't', fields: {} }, { author: 'AUTH', seq: 1 });
    a.send({ t: 'packets', space: 's1', items: ['!!bad!!', b64urlEncode(new Uint8Array([1, 2, 3])), b64urlEncode(good.raw)] });
    expect(a.got('ack')[0]!.ids).toEqual(['AUTH:1']);
  });

  it('answers a fatal error when protocol ranges do not overlap', () => {
    const { connect } = harness();
    const a = connect('a');
    a.send({ t: 'hello', protocol: { min: 5, max: 6 }, device: 'D', spaces: ['s1'], relay: true });
    expect(a.got('error')[0]).toMatchObject({ code: 'protocol-mismatch', fatal: true });
  });

  it('ignores packets for a Space the peer did not declare', async () => {
    const { connect } = harness();
    const a = connect('a');
    a.send(hello(['s1']));
    const e = await remoteEnvelope({ obj: 'o', op: 'create', type: 't', fields: {} }, { author: 'AUTH', seq: 1, space: 'other' });
    a.send({ t: 'packets', space: 'other', items: [b64urlEncode(e.raw)] });
    expect(a.got('ack')).toHaveLength(0);
  });
});
