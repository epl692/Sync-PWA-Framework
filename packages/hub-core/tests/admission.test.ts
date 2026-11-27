// Spec 005 R-2: the relay's admission gate and persistence hooks. The default (no hooks) is the old behavior.
import { describe, expect, it } from 'vitest';
import { ANY_SPACE, b64urlEncode, decodeMessage, encodeMessage, type Msg } from '@sync/core';
import { remoteEnvelope } from '@sync/testkit';
import { RelayHub, type RelayHubOptions } from '../src/relay/relayHub';

function harness(opts: RelayHubOptions = {}) {
  const inbox = new Map<string, Msg[]>();
  const hub = new RelayHub((peer, bytes) => {
    const d = decodeMessage(bytes);
    if (d.ok && 'msg' in d) (inbox.get(peer) ?? inbox.set(peer, []).get(peer)!).push(d.msg);
  }, opts);
  const connect = (id: string) => {
    hub.onConnect(id);
    return {
      send: (m: Msg) => hub.onMessage(id, encodeMessage(m)),
      got: <T extends Msg['t']>(t: T) => (inbox.get(id) ?? []).filter((m) => m.t === t) as Extract<Msg, { t: T }>[],
    };
  };
  return { hub, connect };
}
const hello = (spaces: string[]): Msg => ({ t: 'hello', protocol: { min: 1, max: 1 }, device: 'D', spaces, relay: true });
const env = (seq: number, space = 's1') => remoteEnvelope({ obj: `o${seq}`, op: 'create', type: 't', fields: { a: seq } }, { author: 'AUTH', seq, space });

describe('admit', () => {
  it('is consulted for every declared Space, and a denied Space is dropped from that peer only', async () => {
    const asked: Array<[string, string]> = [];
    const { connect } = harness({ admit: (peer, space) => (asked.push([peer, space]), peer === 'a' || space === 's2') });
    const a = connect('a');
    const b = connect('b');
    a.send(hello(['s1', 's2']));
    b.send(hello(['s1', 's2']));
    expect(a.got('summary').map((s) => s.space)).toEqual(['s1', 's2']);
    expect(b.got('summary').map((s) => s.space)).toEqual(['s2']);
    expect(asked).toContainEqual(['b', 's1']);
  });

  it('a denied peer cannot write to, read from, or want from the denied Space', async () => {
    const { connect, hub } = harness({ admit: (peer) => peer === 'a' });
    const a = connect('a');
    const b = connect('b');
    a.send(hello(['s1']));
    b.send(hello(['s1']));
    const e = await env(1);
    b.send({ t: 'packets', space: 's1', items: [b64urlEncode(e.raw)] });
    expect(hub.stats.packets).toBe(0);
    expect(b.got('ack')).toHaveLength(0);
    a.send({ t: 'packets', space: 's1', items: [b64urlEncode(e.raw)] });
    expect(hub.stats.packets).toBe(1);
    b.send({ t: 'want', space: 's1', ranges: { AUTH: [[1, 1]] } });
    b.send({ t: 'summary', space: 's1', held: {} });
    expect(b.got('packets')).toHaveLength(0);
  });

  it('the wildcard Space from a peer is never a way around the gate', async () => {
    const { connect } = harness({ admit: () => false });
    const a = connect('a');
    a.send(hello([ANY_SPACE, 's1']));
    expect(a.got('summary')).toHaveLength(0);
  });

  it('forwarding skips peers that are not admitted to the Space', async () => {
    const { connect } = harness({ admit: (peer) => peer !== 'c' });
    const a = connect('a');
    const b = connect('b');
    const c = connect('c');
    for (const p of [a, b, c]) p.send(hello(['s1']));
    a.send({ t: 'packets', space: 's1', items: [b64urlEncode((await env(1)).raw)] });
    expect(b.got('packets')).toHaveLength(1);
    expect(c.got('packets')).toHaveLength(0);
  });

  it('with no admit hook every Space is allowed (the reference relay is unchanged)', () => {
    const { connect } = harness();
    const a = connect('a');
    a.send(hello(['s1']));
    expect(a.got('summary')).toHaveLength(1);
  });
});

describe('persistence hooks', () => {
  it('onStore is called once per newly stored packet with the original bytes, never for duplicates', async () => {
    const stored: Array<[string, string, Uint8Array]> = [];
    const { connect } = harness({ onStore: (space, id, raw) => void stored.push([space, id, raw]) });
    const a = connect('a');
    a.send(hello(['s1']));
    const e = await env(1);
    a.send({ t: 'packets', space: 's1', items: [b64urlEncode(e.raw)] });
    a.send({ t: 'packets', space: 's1', items: [b64urlEncode(e.raw)] });
    expect(stored).toHaveLength(1);
    expect(stored[0]![0]).toBe('s1');
    expect(stored[0]![1]).toBe('AUTH:1');
    expect(stored[0]![2]).toEqual(e.raw);
  });

  it('preload restores packets after a restart so a new peer receives them', async () => {
    const first = harness();
    const a = first.connect('a');
    a.send(hello(['s1']));
    const e1 = await env(1);
    const e2 = await env(2);
    a.send({ t: 'packets', space: 's1', items: [b64urlEncode(e1.raw), b64urlEncode(e2.raw)] });
    const dump = first.hub.inspect().spaces[0]!.packets;

    const second = harness();
    for (const raw of dump) expect(second.hub.preload('s1', raw)).toBe(true);
    expect(second.hub.preload('s1', dump[0]!)).toBe(false); // already held
    const b = second.connect('b');
    b.send(hello(['s1']));
    b.send({ t: 'summary', space: 's1', held: {} });
    expect(b.got('packets').flatMap((p) => p.items)).toHaveLength(2);
    expect(b.got('summary')[0]!.held).toEqual({ AUTH: [[1, 2]] });
  });

  it('preload ignores junk and packets for a different Space', async () => {
    const { hub } = harness();
    expect(hub.preload('s1', Uint8Array.of(1, 2, 3))).toBe(false);
    expect(hub.preload('other', (await env(1, 's1')).raw)).toBe(false);
  });

  it('dropPacket forgets the bytes but the Hub still counts the id as held (so peers do not resend it)', async () => {
    const { hub, connect } = harness();
    const a = connect('a');
    a.send(hello(['s1']));
    a.send({ t: 'packets', space: 's1', items: [b64urlEncode((await env(1)).raw)] });
    expect(hub.dropPacket('s1', 'AUTH:1')).toBe(true);
    expect(hub.stats.packets).toBe(0);
    const b = connect('b');
    b.send(hello(['s1']));
    expect(b.got('summary')[0]!.held).toEqual({ AUTH: [[1, 1]] });
    b.send({ t: 'summary', space: 's1', held: {} });
    expect(b.got('packets')).toHaveLength(0); // nothing to serve, no crash
  });
});
