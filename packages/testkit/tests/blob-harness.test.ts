// T014: the blob test harness itself works: secure devices in one Space, lane delivery, fault injection.
import { describe, expect, it } from 'vitest';
import { createBlobPeers, waitFor, flipBit, laneType } from '../src';

const lane = (n: number, type = 5) => {
  const b = new Uint8Array(n).fill(7);
  b[0] = 0xb1;
  b[1] = type;
  return b;
};

describe('blob harness', () => {
  it('builds a Space with N devices and delivers lane messages between them', async () => {
    const p = await createBlobPeers(['a', 'b', 'c']);
    const got: number[] = [];
    const lanes = ['a', 'b', 'c'].map((n) => p.node(n).core.lane(0xb1));
    lanes[1]!.onMessage((_k, bytes) => got.push(bytes.length));
    await waitFor(() => lanes[0]!.peers().length === 2, 8000, 'lane peers');
    await lanes[0]!.send('memory:b', lane(100));
    await waitFor(() => got.length === 1, 3000, 'delivery');
    expect(p.faults.count('chunk')).toBe(1);
    expect(laneType(lane(5))).toBe('chunk');
    await p.close();
  }, 30_000);

  it('drops, duplicates and corrupts lane messages on request, and never touches packets', async () => {
    const p = await createBlobPeers(['a', 'b']);
    const got: Uint8Array[] = [];
    const la = p.node('a').core.lane(0xb1);
    p.node('b').core.lane(0xb1).onMessage((_k, b) => got.push(b));
    await waitFor(() => la.peers().length === 1, 8000, 'peer');
    p.faults.tamper('chunk', { byteOffset: 5 });
    await la.send('memory:b', lane(50));
    await waitFor(() => got.length === 1, 3000, 'tampered message');
    expect(got[0]![5]).toBe(flipBit(lane(50), 5)[5]);
    p.faults.dupRate = 1;
    await la.send('memory:b', lane(50));
    await waitFor(() => got.length === 3, 3000, 'duplicate');
    p.faults.dupRate = 0;
    p.faults.dropRate = 1;
    await la.send('memory:b', lane(50));
    p.faults.dropRate = 0;
    expect(p.faults.stats).toMatchObject({ corrupted: 1, duplicated: 1, dropped: 1 });
    const note = await p.node('a').core.create(p.space, 'note', { x: 1 });
    await waitFor(async () => (await p.node('b').core.get(note.id)) !== undefined, 8000, 'packets still sync');
    await p.close();
  }, 30_000);
});
