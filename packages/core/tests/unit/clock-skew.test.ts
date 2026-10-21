// T060: the drift bound (FR-008) and how a device with a wrong clock behaves.
import { describe, expect, it } from 'vitest';
import { parseClock } from '@sync/core';
import { createPeers, createTestCore, readPacketRecords, remoteEnvelope, waitFor } from '@sync/testkit';

const HOUR = 3_600_000;

describe('clock drift bound (FR-008)', () => {
  it('applies a far-future packet with its own clock but does not pull the local clock past now + maxDrift', async () => {
    const t = await createTestCore({ maxDriftMs: 300_000 });
    const future = await remoteEnvelope({ obj: 'far', op: 'create', type: 't', fields: { x: 1 } }, { author: 'AUTHFUTURE', seq: 1, wall: t.clock.now() + 24 * HOUR });
    expect((await t.core.ingest(future.raw, 'p')).status).toBe('applied');
    expect((await t.core.get('far'))!.fields.x).toBe(1); // still applied: ignoring it would break convergence

    await t.core.create('s1', 't', { y: 1 }, { id: 'unrelated' });
    const mine = (await readPacketRecords(t.storage)).find((p) => p.obj === 'unrelated')!;
    expect(parseClock(mine.clock)!.wall).toBeLessThanOrEqual(t.clock.now() + 300_000);
  });

  it('lets a device with a clock hours ahead win only edits that the other side has not seen', async () => {
    const p = await createPeers(['fast', 'ok'], { spaces: ['s1'] });
    // The skewed device is emulated by a packet authored with a wall clock two hours ahead.
    const skewed = await remoteEnvelope({ obj: 'o1', op: 'create', type: 't', fields: { x: 'skewed' } }, { author: 'SKEWEDDEVICE', seq: 1, wall: p.peers.ok!.clock.now() + 2 * HOUR });
    await p.core('ok').ingest(skewed.raw, 'x');
    await p.core('fast').ingest(skewed.raw, 'x');

    // the user on `ok` has now seen the skewed value; their later edit must win everywhere
    await p.core('ok').update('o1', { x: 'corrected' });
    p.link('fast', 'ok');
    await p.converged('s1');
    expect((await p.core('fast').get('o1'))!.fields.x).toBe('corrected');
    expect((await p.core('ok').get('o1'))!.fields.x).toBe('corrected');

    // and it keeps working: further edits on either side win in turn
    await p.core('fast').update('o1', { x: 'again' });
    await waitFor(async () => (await p.core('ok').get('o1'))?.fields.x === 'again', 3000, 'follow-up edit');
  });

  it('does not let a device with a clock far in the past lose an edit made after it saw the newer value', async () => {
    const t = await createTestCore();
    const current = await remoteEnvelope({ obj: 'o1', op: 'create', type: 't', fields: { x: 'newer' } }, { author: 'OTHERDEVICE', seq: 1, wall: t.clock.now() + 1000 });
    await t.core.ingest(current.raw, 'p');
    t.clock.set(t.clock.now() - 5 * 365 * 24 * HOUR); // this device's clock jumps back years
    await t.core.update('o1', { x: 'mine' });
    expect((await t.core.get('o1'))!.fields.x).toBe('mine');
  });

  it('breaks truly concurrent edits the same way on every device', async () => {
    const a = await remoteEnvelope({ obj: 'o1', op: 'create', type: 't', fields: { x: 'A' } }, { author: 'DEVICEAA', seq: 1, wall: 1000 });
    const b = await remoteEnvelope({ obj: 'o1', op: 'update', type: 't', fields: { x: 'B' } }, { author: 'DEVICEBB', seq: 1, wall: 1000 });
    const results = new Set<unknown>();
    for (const order of [[a, b], [b, a]]) {
      const t = await createTestCore();
      for (const e of order) await t.core.ingest(e.raw, 'p');
      results.add((await t.core.get('o1'))!.fields.x);
    }
    expect(results.size).toBe(1);
  });
});
