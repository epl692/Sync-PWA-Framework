// T058: a peer without the lane (an older, plain 001/002 peer) keeps syncing packets and is never sent lane bytes.
import { describe, expect, it } from 'vitest';
import { waitFor } from '@sync/testkit';
import { CHUNK_BYTES, decodeLaneMessage, encodeLaneMessage, type LaneMsg } from '../../src';
import { SPACE, pattern, plainPeers } from '../helpers';

describe('mixed versions', () => {
  it('converges on packets across all three devices while the blob pair transfers, and the old device is never sent a lane byte', async () => {
    const t = await plainPeers(['a', 'b', 'old'], {}, 1, { skip: ['old'] }); // `old` never registers the lane
    const bytes = pattern(CHUNK_BYTES * 2 + 3);
    const ref = await t.attach('a', bytes);
    const note = await t.p.core('a').create(SPACE, 'note', { photo: ref as never });
    await waitFor(async () => (await t.p.core('old').get(note.id)) !== undefined, 10_000, 'object on the old device');
    // the old device stores the reference as an ordinary field
    expect(((await t.p.core('old').get(note.id))!.fields.photo as { id: string }).id).toBe(ref.id);
    await t.engines.b!.request(ref);
    expect(t.engines.b!.observe(ref).get().state).toBe('available');
    expect(t.faults.sent.filter((s) => s.to === 'old')).toEqual([]);
    await t.close();
  }, 60_000);

  it('treats a peer that speaks another blob version as having no blob lane: it is sent nothing and what it sends is ignored', async () => {
    const t = await plainPeers(['a', 'raw'], {}, 1, { skip: ['raw'] });
    const lane = t.p.core('raw').lane(0xb1);
    const got: LaneMsg[] = [];
    lane.onMessage((_k, b) => {
      const d = decodeLaneMessage(b);
      if (d.ok && 'msg' in d) got.push(d.msg);
    });
    await waitFor(() => lane.peers().length === 1, 10_000, 'raw lane peer');
    const toA = (m: LaneMsg) => lane.send('memory:a', encodeLaneMessage(m));
    await toA({ type: 'hello', v: 2, window: 8, maxChunks: 4096, serve: true }); // a future blob protocol
    const ref = await t.attach('a', pattern(5000));
    await new Promise((r) => setTimeout(r, 200));
    expect(got.some((m) => m.type === 'offer')).toBe(false); // never offered to an incompatible peer
    await toA({ type: 'get', id: ref.id, manifest: true, space: SPACE, ranges: [[0, 0]] });
    await new Promise((r) => setTimeout(r, 150));
    expect(got.some((m) => m.type === 'chunk' || m.type === 'manifest')).toBe(false); // ... and not served
    await t.close();
  }, 60_000);
});
