// T043 (Story 2): two online devices see each other's changes without refresh.
import { describe, expect, it } from 'vitest';
import { createPeers, flush, readOutbox, readPacketRecords, waitFor } from '@sync/testkit';

describe('Story 2: realtime updates from data packets', () => {
  it("shows device A's edit in device B's live query (scenario 1)", async () => {
    const p = await createPeers(['a', 'b'], { spaces: ['s1'] });
    p.link('a', 'b');
    const o = await p.core('a').create('s1', 'note', { title: 'v1' });
    await waitFor(async () => (await p.core('b').get(o.id))?.fields.title === 'v1', 3000, 'create on b');

    const seen: unknown[] = [];
    p.core('b').query({ id: o.id }).subscribe((r) => seen.push(r[0]?.fields.title));
    await p.core('a').update(o.id, { title: 'v2' });
    await waitFor(() => seen.includes('v2'), 3000, 'live update on b');
    expect(seen).toEqual(['v1', 'v2']);
  });

  it('adds a newly created object to a live query over its type (scenario 2)', async () => {
    const p = await createPeers(['a', 'b'], { spaces: ['s1'] });
    p.link('a', 'b');
    const titles: string[][] = [];
    p.core('b').query({ type: 'note' }).subscribe((r) => titles.push(r.map((o) => o.fields.t as string)));
    await p.core('a').create('s1', 'note', { t: 'first' });
    await waitFor(() => titles.some((t) => t.includes('first')), 3000, 'create arrives');
  });

  it('propagates deletes', async () => {
    const p = await createPeers(['a', 'b'], { spaces: ['s1'] });
    p.link('a', 'b');
    const o = await p.core('a').create('s1', 'note', { t: 'x' });
    await waitFor(async () => !!(await p.core('b').get(o.id)), 3000, 'create on b');
    await p.core('a').remove(o.id);
    await waitFor(async () => !(await p.core('b').get(o.id)), 3000, 'delete on b');
  });

  it('does nothing when an already-applied packet arrives again (scenario 3)', async () => {
    const p = await createPeers(['a', 'b'], { spaces: ['s1'] });
    p.link('a', 'b');
    const o = await p.core('a').create('s1', 'note', { t: 'x' });
    await waitFor(async () => !!(await p.core('b').get(o.id)), 3000, 'create on b');
    let emits = 0;
    p.core('b').query({ type: 'note' }).subscribe(() => emits++);
    const before = await p.core('b').stateHash('s1');
    const rec = (await readPacketRecords(p.peers.b!.storage))[0]!;
    expect(await p.core('b').ingest(rec.raw, 'again')).toMatchObject({ status: 'duplicate' });
    await flush();
    expect(emits).toBe(1);
    expect(await p.core('b').stateHash('s1')).toBe(before);
  });

  it('clears the outbox once the peer acknowledges', async () => {
    const p = await createPeers(['a', 'b'], { spaces: ['s1'] });
    await p.core('a').create('s1', 'note', { t: 'offline' });
    expect(await readOutbox(p.peers.a!.storage)).toHaveLength(1);
    p.link('a', 'b');
    await waitFor(async () => (await readOutbox(p.peers.a!.storage)).length === 0, 3000, 'outbox cleared by ack');
  });

  it('lets a brand-new device join a Space and catch up', async () => {
    const p = await createPeers(['a', 'b', 'c'], { spaces: ['s1'] });
    p.link('a', 'b');
    for (let i = 0; i < 5; i++) await p.core('a').create('s1', 'note', { i });
    await p.converged('s1', ['a', 'b']);
    p.link('b', 'c');
    await p.converged('s1', ['a', 'b', 'c']);
    expect(await p.core('c').query({ type: 'note' }).once()).toHaveLength(5);
  });

  it('syncs offline edits made on both sides after they connect', async () => {
    const p = await createPeers(['a', 'b'], { spaces: ['s1'] });
    for (let i = 0; i < 3; i++) await p.core('a').create('s1', 'note', { from: 'a', i });
    for (let i = 0; i < 3; i++) await p.core('b').create('s1', 'note', { from: 'b', i });
    p.link('a', 'b');
    await p.converged('s1');
    expect(await p.core('a').query({ type: 'note' }).once()).toHaveLength(6);
  });
});
