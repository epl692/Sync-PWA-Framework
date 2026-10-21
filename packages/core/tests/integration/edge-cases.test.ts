// T092: the spec's edge cases, end to end. (Individual behaviours are also unit-tested next to their code.)
import { describe, expect, it } from 'vitest';
import { decodeMessage, encodeMessage } from '@sync/core';
import { MemoryNetwork, createPeers, createTestCore, readPacketRecords, remoteEnvelope, waitFor } from '@sync/testkit';

const HOUR = 3_600_000;
const YEAR = 365 * 24 * HOUR;

describe('edge cases', () => {
  it('a device with a badly wrong clock does not win forever', async () => {
    const p = await createPeers(['ahead', 'right'], { spaces: ['s1'] });
    // "ahead" authors an edit stamped three years in the future
    const skewed = await remoteEnvelope({ obj: 'o1', op: 'create', type: 't', fields: { v: 'from the future' } }, { author: 'AHEADDEVICE', seq: 1, wall: p.peers.right!.clock.now() + 3 * YEAR });
    await p.core('ahead').ingest(skewed.raw, 'x');
    p.link('ahead', 'right');
    await p.converged('s1');
    await p.core('right').update('o1', { v: 'corrected' });
    await p.converged('s1');
    expect((await p.core('ahead').get('o1'))!.fields.v).toBe('corrected');
  });

  it('stores and relays a packet of an unknown type and a newer format across a chain of devices', async () => {
    const p = await createPeers(['a', 'b', 'c'], { spaces: ['s1'] });
    p.link('a', 'b');
    p.link('b', 'c');
    const newer = new TextEncoder().encode(JSON.stringify({ v: 3, id: 'FUTUREDEVICE:1', author: 'FUTUREDEVICE', seq: 1, space: 's1', body: 'whatever' }));
    const martian = await remoteEnvelope({ obj: 'o1', op: 'create', type: 'martian', schemaVersion: 42, fields: { x: 1 } }, { author: 'FUTUREDEVICE', seq: 2 });
    await p.core('a').ingest(newer, 'x');
    await p.core('a').ingest(martian.raw, 'x');
    await waitFor(async () => (await readPacketRecords(p.peers.c!.storage)).length === 2, 5000, 'both packets to reach c');
    const stored = await readPacketRecords(p.peers.c!.storage);
    expect(stored.find((r) => r.seq === 1)!.status).toBe('parked'); // newer format: kept for later
    expect(await p.core('c').get('o1')).toMatchObject({ type: 'martian', schemaVersion: 42 }); // unknown type: generic
  });

  it('a peer on an older protocol is refused, and the app keeps working with others', async () => {
    const net = new MemoryNetwork();
    const t = await createTestCore({ spaces: ['s1'] });
    t.core.addTransport(net.transport('core', 'old'));
    const oldPeer = net.transport('old-peer', 'old');
    const errors: string[] = [];
    oldPeer.on('message', (_p, b) => {
      const d = decodeMessage(b);
      if (d.ok && 'msg' in d && d.msg.t === 'error') errors.push(d.msg.code);
    });
    await oldPeer.start();
    net.link('core', 'old-peer', 'old');
    await oldPeer.send('core', encodeMessage({ t: 'hello', protocol: { min: 0, max: 0 }, device: 'OLD', spaces: ['s1'], relay: true }));
    await waitFor(() => errors.length > 0, 3000, 'protocol error');
    expect(errors).toEqual(['protocol-mismatch']);
    expect((await t.core.create('s1', 'note', { still: 'works' })).fields.still).toBe('works');
  });

  it('corrupt packets from a peer are rejected one by one and never stop later packets', async () => {
    const t = await createTestCore();
    const good = await remoteEnvelope({ obj: 'o1', op: 'create', type: 't', fields: { a: 1 } }, { seq: 1 });
    const junk = [new Uint8Array([1, 2, 3]), good.raw.slice(0, 30), new TextEncoder().encode('{"v":1}')];
    const results = await t.core.ingestBatch([...junk, good.raw], 'peer');
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected', 'applied']);
    expect(await t.core.get('o1')).toBeDefined();
  });

  it('keeps state after a restart in the middle of an incoming sync', async () => {
    const p = await createPeers(['a', 'b'], { spaces: ['s1'], batch: { packets: 20 } as never });
    for (let i = 0; i < 100; i++) await p.core('a').create('s1', 'item', { i });
    let cut = false;
    p.net.tap((from, _to, bytes) => {
      const d = decodeMessage(bytes);
      if (!cut && from === 'a' && d.ok && 'msg' in d && d.msg.t === 'packets') {
        cut = true;
        queueMicrotask(() => p.net.sever('a', 'b'));
      }
    });
    p.link('a', 'b');
    await waitFor(() => cut, 3000, 'first batch');
    await new Promise((r) => setTimeout(r, 40));
    await p.peers.b!.core.close(); // b is shut down mid-sync ...
    const reopened = await p.peers.b!.reopen(); // ... and restarts with a partial copy
    expect((await reopened.query({ type: 'item' }).once()).length).toBeLessThan(100);
    reopened.addTransport(p.net.transport('b')); // the app re-attaches its transports on start
    p.net.restore('a', 'b');
    await waitFor(async () => (await p.peers.b!.core.query({ type: 'item' }).once()).length === 100, 8000, 'b to catch up');
  });
});
