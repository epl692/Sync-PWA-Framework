// T070 (FR-008, US3.2): unreferenced blobs are removed from the device after the retention window; orphans after a day.
import { describe, expect, it } from 'vitest';
import { pattern, testBlobs } from '../helpers';

const SPACE = 'SPACE1';
const DAY = 24 * 60 * 60 * 1000;
const settle = () => new Promise((r) => setTimeout(r, 20));
const attach = (t: Awaited<ReturnType<typeof testBlobs>>, seed: number) => t.blobs.attach(new Blob([pattern(300_000, seed) as BlobPart]), { space: SPACE, obj: `o${seed}` });

describe('garbage collection', () => {
  it('deletes a blob 30 days after its last reference went, with its chunks, and says so', async () => {
    const t = await testBlobs();
    const ref = await attach(t, 1);
    const o = await t.core.create(SPACE, 'note', { photo: ref as never });
    await settle();
    t.clock.advance(DAY);
    await t.core.remove(o.id);
    await settle();
    const events: string[] = [];
    t.blobs.on('blob:deleted', (e) => events.push(`${e.reason}:${e.id === ref.id}`));

    t.clock.advance(29 * DAY);
    expect(await t.blobs.collect()).toBe(0); // 29 days after: not yet
    t.clock.advance(2 * DAY);
    expect(await t.blobs.collect()).toBe(1);
    expect(await t.storage.getBlob(ref.id)).toBeUndefined();
    expect(await t.storage.presentChunks(ref.id)).toEqual([]);
    expect(await t.storage.usedBytes()).toBe(0);
    expect(events).toEqual(['unreferenced:true']);
    expect(t.blobs.observe(ref).get().state).not.toBe('available');
  });

  it('keeps it when the object comes back before the window ends (undo), and starts a fresh clock after the next delete', async () => {
    const t = await testBlobs();
    const ref = await attach(t, 1);
    const o = await t.core.create(SPACE, 'note', { photo: ref as never });
    await settle();
    await t.core.remove(o.id);
    await settle();
    t.clock.advance(20 * DAY);
    await t.core.undo(o.id);
    await settle();
    expect((await t.storage.getBlob(ref.id))!.unreferencedAt).toBeNull();
    t.clock.advance(60 * DAY);
    expect(await t.blobs.collect()).toBe(0);
    expect(await t.storage.getBlob(ref.id)).toBeDefined();

    await t.core.remove(o.id);
    await settle();
    t.clock.advance(31 * DAY);
    expect(await t.blobs.collect()).toBe(1);
  });

  it('keeps a blob that another object still references', async () => {
    const t = await testBlobs();
    const ref = await attach(t, 1);
    const a = await t.core.create(SPACE, 'note', { photo: ref as never });
    await t.core.create(SPACE, 'note', { photo: ref as never });
    await settle();
    await t.core.remove(a.id);
    await settle();
    t.clock.advance(90 * DAY);
    expect(await t.blobs.collect()).toBe(0);
    expect(await t.storage.getBlob(ref.id)).toBeDefined();
  });

  it('removes an attachment nobody ever referenced after a day, and keeps one that was referenced in time', async () => {
    const t = await testBlobs();
    const orphan = await attach(t, 1);
    const used = await attach(t, 2);
    await t.core.create(SPACE, 'note', { photo: used as never });
    await settle();
    t.clock.advance(23 * DAY / 24);
    expect(await t.blobs.collect()).toBe(0);
    t.clock.advance(2 * 60 * 60 * 1000);
    const events: string[] = [];
    t.blobs.on('blob:deleted', (e) => events.push(e.reason));
    expect(await t.blobs.collect()).toBe(1);
    expect(await t.storage.getBlob(orphan.id)).toBeUndefined();
    expect(await t.storage.getBlob(used.id)).toBeDefined();
    expect(events).toEqual(['orphan']);
  });

  it('honours configured retention and grace periods', async () => {
    const t = await testBlobs({ retentionMs: 2 * DAY, orphanGraceMs: 1000 });
    const ref = await attach(t, 1);
    t.clock.advance(2000);
    expect(await t.blobs.collect()).toBe(1);
    const ref2 = await attach(t, 2);
    const o = await t.core.create(SPACE, 'note', { photo: ref2 as never });
    await settle();
    await t.core.remove(o.id);
    await settle();
    t.clock.advance(3 * DAY);
    expect(await t.blobs.collect()).toBe(1);
    void ref;
  });
});
