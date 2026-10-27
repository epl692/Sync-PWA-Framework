// T033: attaching never slows or blocks sync; offers go out in the background; replicas are recorded (US1, FR-003, FR-011).
import { describe, expect, it } from 'vitest';
import { newId } from '@sync/core';
import { createBlobPeers, laneType, readPacketRecords, waitFor, type BlobPeers } from '@sync/testkit';
import { createBlobs, createMemoryBlobStorage, decodeLaneMessage, encodeLaneMessage, type Blobs, type BlobRef } from '../../src';
import { pattern } from '../helpers';

async function engine(p: BlobPeers, name: string): Promise<Blobs> {
  const n = p.node(name);
  return createBlobs({ core: n.core, keys: n.spaces.blobKeys, storage: createMemoryBlobStorage() });
}
const attachOn = async (p: BlobPeers, blobs: Blobs, device: string, size = 300_000) => {
  const id = newId();
  const ref = await blobs.attach(new Blob([pattern(size) as BlobPart]), { space: p.space, obj: id });
  const note = await p.node(device).core.create(p.space, 'note', { photo: ref as never }, { id });
  return { id, ref, note };
};
const offersTo = (p: BlobPeers, from: string, to: string) => p.faults.sent.filter((s) => s.from === from && s.to === to && laneType(s.bytes) === 'offer').length;

describe('attach and offer', () => {
  it('syncs the object at once with a reference of under 1 KiB, offers the blob, and downloads nothing unrequested', async () => {
    const p = await createBlobPeers(['a', 'b', 'c', 'legacy'], { outsiders: ['c'] });
    const [A, B] = [await engine(p, 'a'), await engine(p, 'b')];
    await engine(p, 'c'); // an outsider with the engine: not in the Space
    const { id, ref } = await attachOn(p, A, 'a');
    await waitFor(async () => (await p.node('b').core.get(id)) !== undefined, 10_000, 'object on b');
    const rec = (await readPacketRecords(p.node('b').storage)).find((r) => r.obj === id)!;
    expect(rec.raw.length).toBeLessThan(1024);
    expect(B.observe(ref as BlobRef).get()).toMatchObject({ state: 'missing', reason: 'not-requested', size: 300_000, progress: 0 });
    await waitFor(() => offersTo(p, 'a', 'b') >= 1, 10_000, 'offer to b');
    await new Promise((r) => setTimeout(r, 100));
    expect(p.faults.count('get')).toBe(0);
    expect(p.faults.count('chunk')).toBe(0);
    expect(offersTo(p, 'a', 'c')).toBe(0); // c is not in the Space
    expect(p.faults.sent.filter((s) => s.to === 'legacy')).toEqual([]); // legacy never advertised the lane
    await p.close();
  }, 60_000);

  it('offers a blob attached offline once a peer appears (US1.3)', async () => {
    const p = await createBlobPeers(['a', 'b']);
    const A = await engine(p, 'a');
    await engine(p, 'b');
    await waitFor(() => p.node('a').core.peers().some((x) => x.spaces.length && x.lanes.length), 10_000, 'lane peer');
    p.g.net.sever('a', 'b');
    await waitFor(() => p.node('a').core.peers().length === 0, 5000, 'disconnected');
    const before = offersTo(p, 'a', 'b');
    await attachOn(p, A, 'a');
    await new Promise((r) => setTimeout(r, 100));
    expect(offersTo(p, 'a', 'b')).toBe(before);
    p.g.net.restore('a', 'b');
    await waitFor(() => offersTo(p, 'a', 'b') > before, 10_000, 'offer after reconnect');
    await p.close();
  }, 60_000);

  it('records a replica on `stored`, once per peer, and stops offering a blob a peer rejected', async () => {
    const p = await createBlobPeers(['a', 'raw']);
    const A = await engine(p, 'a');
    const raw = p.node('raw').core.lane(0xb1);
    const got: ReturnType<typeof decodeLaneMessage>[] = [];
    raw.onMessage((_k, b) => got.push(decodeLaneMessage(b)));
    await waitFor(() => raw.peers().length === 1, 10_000, 'raw lane peer');
    const toA = (m: Parameters<typeof encodeLaneMessage>[0]) => raw.send('memory:a', encodeLaneMessage(m));
    await toA({ type: 'hello', v: 1, window: 8, maxChunks: 4096, serve: true });

    const first = await attachOn(p, A, 'a');
    await waitFor(() => got.some((m) => m.ok && 'msg' in m && m.msg.type === 'offer' && m.msg.id === first.ref.id), 10_000, 'offer for the first blob');
    await toA({ type: 'stored', id: first.ref.id });
    await waitFor(() => A.observe(first.ref as BlobRef).get().replicas === 1, 5000, 'replica recorded');
    await toA({ type: 'stored', id: first.ref.id });
    await new Promise((r) => setTimeout(r, 50));
    expect(A.observe(first.ref as BlobRef).get().replicas).toBe(1);

    // reject: the same content attached again is offered to others but not to the peer that refused it
    const second = await attachOn(p, A, 'a', 300_001);
    await waitFor(() => got.some((m) => m.ok && 'msg' in m && m.msg.type === 'offer' && m.msg.id === second.ref.id), 10_000, 'offer for the second blob');
    await toA({ type: 'reject', id: second.ref.id, reason: 'quota' });
    await new Promise((r) => setTimeout(r, 50));
    const seen = got.filter((m) => m.ok && 'msg' in m && m.msg.type === 'offer' && m.msg.id === second.ref.id).length;
    await attachOn(p, A, 'a', 300_001); // identical bytes: same ID, offerBlob runs again
    await new Promise((r) => setTimeout(r, 100));
    expect(got.filter((m) => m.ok && 'msg' in m && m.msg.type === 'offer' && m.msg.id === second.ref.id)).toHaveLength(seen);
    await p.close();
  }, 60_000);

  it('answers an offer of a blob it holds with `stored`, and ignores an offer nobody asked for (never an automatic get)', async () => {
    const p = await createBlobPeers(['a', 'raw']);
    const A = await engine(p, 'a');
    const raw = p.node('raw').core.lane(0xb1);
    const got: Array<NonNullable<Extract<ReturnType<typeof decodeLaneMessage>, { msg: unknown }>['msg']>> = [];
    raw.onMessage((_k, b) => {
      const d = decodeLaneMessage(b);
      if (d.ok && 'msg' in d) got.push(d.msg);
    });
    await waitFor(() => raw.peers().length === 1, 10_000, 'raw lane peer');
    await raw.send('memory:a', encodeLaneMessage({ type: 'hello', v: 1, window: 8, maxChunks: 4096, serve: true }));
    const { ref } = await attachOn(p, A, 'a');
    await raw.send('memory:a', encodeLaneMessage({ type: 'offer', space: p.space, id: ref.id, size: ref.size }));
    await waitFor(() => got.some((m) => m.type === 'stored' && m.id === ref.id), 5000, 'stored answer');
    const stranger = 'Y'.repeat(43);
    await raw.send('memory:a', encodeLaneMessage({ type: 'offer', space: p.space, id: stranger, size: 1000 }));
    await new Promise((r) => setTimeout(r, 150));
    expect(got.some((m) => (m.type === 'get' || m.type === 'stored') && m.id === stranger)).toBe(false);
    expect(p.faults.count('get', 'a')).toBe(0);
    await p.close();
  }, 60_000);
});
