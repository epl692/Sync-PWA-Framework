// T046: serving and fetching (US2, FR-004, FR-005, FR-011). Real secure devices, the real lane.
import { describe, expect, it } from 'vitest';
import { newId } from '@sync/core';
import { createBlobPeers, waitFor, type BlobPeers } from '@sync/testkit';
import { CHUNK_BYTES, createBlobs, createMemoryBlobStorage, decodeLaneMessage, encodeLaneMessage, type BlobStatus, type Blobs, type LaneMsg } from '../../src';
import { pattern } from '../helpers';

async function engine(p: BlobPeers, name: string, config = {}): Promise<Blobs> {
  const n = p.node(name);
  return createBlobs({ core: n.core, keys: n.spaces.blobKeys, storage: createMemoryBlobStorage(), config });
}
const attach = (p: BlobPeers, A: Blobs, size: number) => A.attach(new Blob([pattern(size) as BlobPart]), { space: p.space, obj: newId() });
const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

const decoded = (p: BlobPeers, from: string, to: string): LaneMsg[] =>
  p.faults.sent.filter((s) => s.from === from && s.to === to).flatMap((s) => {
    const d = decodeLaneMessage(s.bytes);
    return d.ok && 'msg' in d ? [d.msg] : [];
  });

describe('fetch from a peer', () => {
  it('goes missing → downloading → available with rising progress, and the bytes match', async () => {
    const p = await createBlobPeers(['a', 'b']);
    const [A, B] = [await engine(p, 'a'), await engine(p, 'b')];
    const size = CHUNK_BYTES * 3 + 123;
    const ref = await attach(p, A, size);
    const seen: BlobStatus[] = [];
    B.observe(ref).subscribe((s) => seen.push(s));
    expect(B.observe(ref).get()).toMatchObject({ state: 'missing', reason: 'not-requested' });
    await B.request(ref);
    expect(B.observe(ref).get()).toMatchObject({ state: 'available', progress: 1 });
    expect(seen.some((s) => s.state === 'downloading')).toBe(true);
    const progress = seen.filter((s) => s.state === 'downloading').map((s) => s.bytesDone);
    expect(progress).toEqual([...progress].sort((x, y) => x - y));
    expect(same(await bytesOf(await B.toBlob(ref)), pattern(size))).toBe(true);
    await p.close();
  }, 60_000);

  it('asks for the manifest in the first get, then only the missing ranges, with at most a window of chunks outstanding', async () => {
    const p = await createBlobPeers(['a', 'b']);
    const [A, B] = [await engine(p, 'a'), await engine(p, 'b', { window: 4 })];
    const n = 20;
    const ref = await attach(p, A, CHUNK_BYTES * n);
    await B.request(ref);
    const gets = decoded(p, 'b', 'a').filter((m): m is Extract<LaneMsg, { type: 'get' }> => m.type === 'get');
    expect(gets[0]!.manifest).toBe(true);
    expect(gets.slice(1).every((g) => !g.manifest)).toBe(true);
    const requested = gets.flatMap((g) => g.ranges.flatMap(([lo, hi]) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)));
    expect(new Set(requested).size).toBe(n); // every chunk requested exactly once
    expect(requested).toHaveLength(n);
    // outstanding = requested - received, never above the window
    let out = 0, max = 0;
    for (const s of p.faults.sent) {
      const d = decodeLaneMessage(s.bytes);
      if (!d.ok || !('msg' in d)) continue;
      if (s.from === 'b' && d.msg.type === 'get') out += d.msg.ranges.reduce((a, [lo, hi]) => a + hi - lo + 1, 0);
      if (s.from === 'a' && d.msg.type === 'chunk') out--;
      max = Math.max(max, out);
    }
    expect(max).toBeLessThanOrEqual(4);
    await p.close();
  }, 60_000);

  it('answers `miss` when a peer lacks the blob, and still completes from the one that has it', async () => {
    const p = await createBlobPeers(['a', 'b', 'c']);
    const [A, B] = [await engine(p, 'a'), await engine(p, 'b')];
    await engine(p, 'c');
    const ref = await attach(p, A, CHUNK_BYTES * 2);
    await waitFor(() => p.node('b').core.peers().filter((x) => x.lanes.length && x.spaces.length).length === 2, 10_000, 'peers');
    await B.request(ref);
    expect(decoded(p, 'c', 'b').some((m) => m.type === 'miss')).toBe(true);
    expect(B.observe(ref).get().state).toBe('available');
    await p.close();
  }, 60_000);

  async function rawPeer(p: BlobPeers, name: string) {
    const raw = p.node(name).core.lane(0xb1);
    const got: LaneMsg[] = [];
    raw.onMessage((_k, b) => {
      const d = decodeLaneMessage(b);
      if (d.ok && 'msg' in d) got.push(d.msg);
    });
    await waitFor(() => raw.peers().length >= 1, 10_000, 'raw lane peer');
    const toA = (m: LaneMsg) => raw.send('memory:a', encodeLaneMessage(m));
    await toA({ type: 'hello', v: 1, window: 8, maxChunks: 4096, serve: true });
    return { got, toA };
  }

  it('rejects a get for a Space it does not share with that peer', async () => {
    const p = await createBlobPeers(['a', 'out'], { outsiders: ['out'] });
    const A = await engine(p, 'a');
    const { got, toA } = await rawPeer(p, 'out');
    const ref = await attach(p, A, CHUNK_BYTES * 3);
    await toA({ type: 'get', id: ref.id, manifest: true, space: p.space, ranges: [[0, 2]] });
    await waitFor(() => got.some((m) => m.type === 'reject' && m.reason === 'space'), 5000, 'reject');
    expect(got.some((m) => m.type === 'chunk' || m.type === 'manifest')).toBe(false);
    await p.close();
  }, 60_000);

  it('stops serving a blob after cancel', async () => {
    const p = await createBlobPeers(['a', 'raw']);
    const A = await engine(p, 'a');
    const { got, toA } = await rawPeer(p, 'raw');
    const ref = await attach(p, A, CHUNK_BYTES * 60);
    await toA({ type: 'get', id: ref.id, manifest: true, space: p.space, ranges: [[0, 59]] });
    await waitFor(() => got.some((m) => m.type === 'chunk'), 5000, 'first chunk');
    await toA({ type: 'cancel', id: ref.id });
    await new Promise((r) => setTimeout(r, 300));
    const served = got.filter((m) => m.type === 'chunk').length;
    expect(served).toBeGreaterThan(0);
    expect(served).toBeLessThan(60);
    await new Promise((r) => setTimeout(r, 200));
    expect(got.filter((m) => m.type === 'chunk').length).toBe(served); // and it stays stopped
    await p.close();
  }, 60_000);

  it('parks as missing / no-source with no holder online and completes by itself when one comes back', async () => {
    const p = await createBlobPeers(['a', 'b']);
    const [A, B] = [await engine(p, 'a'), await engine(p, 'b')];
    const ref = await attach(p, A, CHUNK_BYTES + 5);
    await waitFor(() => p.node('b').core.peers().some((x) => x.lanes.length && x.spaces.length), 10_000, 'peer');
    p.g.net.sever('a', 'b');
    await waitFor(() => p.node('b').core.peers().length === 0, 5000, 'gone');
    const done = B.request(ref);
    await waitFor(() => B.observe(ref).get().reason === 'no-source', 5000, 'no source');
    expect(B.observe(ref).get().state).toBe('missing');
    p.g.net.restore('a', 'b');
    await done;
    expect(B.observe(ref).get().state).toBe('available');
    await p.close();
  }, 60_000);

  it('joins a request already in flight instead of starting a second download', async () => {
    const p = await createBlobPeers(['a', 'b']);
    const [A, B] = [await engine(p, 'a'), await engine(p, 'b')];
    const ref = await attach(p, A, CHUNK_BYTES * 4);
    await Promise.all([B.request(ref), B.request(ref)]);
    expect(p.faults.count('chunk', 'a')).toBe(4);
    await p.close();
  }, 60_000);
});
