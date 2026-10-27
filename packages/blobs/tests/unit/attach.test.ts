// T031: the streaming attach pipeline (FR-001, FR-002, FR-007, FR-012; research R-04).
import { describe, expect, it } from 'vitest';
import { BlobKeyError, BlobTooLargeError, CHUNK_BYTES } from '../../src';
import { blobVectors, keyVectors, pattern, spySource, testBlobs } from '../helpers';

const SPACE = 'SPACE1';

describe('attach', () => {
  it('rejects an empty file', async () => {
    const t = await testBlobs();
    await expect(t.blobs.attach(new Blob([]), { space: SPACE, obj: 'o1' })).rejects.toThrow(/empty/);
  });

  it.each(blobVectors.cases)('matches the known-answer vector for $name (id, size, scope, key)', async (c) => {
    const t = await testBlobs();
    const ref = await t.blobs.attach(new Blob([pattern(c.size) as BlobPart]), { space: SPACE, obj: 'o1' });
    expect(ref).toMatchObject({ $blob: 1, id: c.id, size: c.size, type: 'application/octet-stream', space: SPACE, scope: SPACE, keyId: keyVectors.keyId });
    // the ciphertext chunks are stored under the final ID, with the vector digests
    expect(await t.storage.presentChunks(ref.id)).toEqual(c.chunks.map((k) => k.index));
    for (const k of c.chunks) expect((await t.storage.getChunk(ref.id, k.index))!.length).toBe(k.storedLength);
    const rec = (await t.storage.getBlob(ref.id))!;
    expect(rec).toMatchObject({ origin: 'local', complete: true, replicas: [], pinned: false, unreferencedAt: null });
    expect(await t.blobs.observe(ref).get()).toMatchObject({ state: 'available', progress: 1, replicas: 0 });
  });

  it('takes the media type from the options, then the Blob, then application/octet-stream, and rejects a bad one', async () => {
    const t = await testBlobs();
    const png = new Blob([pattern(10) as BlobPart], { type: 'image/png' });
    expect((await t.blobs.attach(png, { space: SPACE, obj: 'o1' })).type).toBe('image/png');
    expect((await t.blobs.attach(png, { space: SPACE, obj: 'o1', type: 'IMAGE/JPEG' })).type).toBe('image/jpeg');
    expect((await t.blobs.attach(new Blob([pattern(11) as BlobPart]), { space: SPACE, obj: 'o1' })).type).toBe('application/octet-stream');
    await expect(t.blobs.attach(png, { space: SPACE, obj: 'o1', type: 'not a type' })).rejects.toThrow(TypeError);
  });

  it('keeps a File name, shortened to 255 characters, and prefers an explicit name', async () => {
    const t = await testBlobs();
    const f = new File([pattern(10) as BlobPart], 'holiday.png');
    expect((await t.blobs.attach(f, { space: SPACE, obj: 'o1' })).name).toBe('holiday.png');
    expect((await t.blobs.attach(f, { space: SPACE, obj: 'o1', name: 'x'.repeat(300) })).name).toHaveLength(255);
  });

  it('encrypts an object of an override share under the share scope and key, and others under the Space', async () => {
    const t = await testBlobs();
    const inShare = await t.blobs.attach(new Blob([pattern(20) as BlobPart]), { space: SPACE, obj: 'share-gift' });
    const plain = await t.blobs.attach(new Blob([pattern(20) as BlobPart]), { space: SPACE, obj: 'note-1' });
    expect(inShare.scope).toBe('SHARE1');
    expect(plain.scope).toBe(SPACE);
    expect(inShare.keyId).not.toBe(plain.keyId);
    expect(inShare.id).not.toBe(plain.id); // same bytes, different scope: different blob
  });

  it('reads one chunk at a time and never the whole file', async () => {
    const t = await testBlobs();
    const size = CHUNK_BYTES * 3 + 5;
    const { source, slices } = spySource(size);
    await t.blobs.attach(source, { space: SPACE, obj: 'o1' });
    expect(slices).toHaveLength(4);
    expect(slices.every(([a, b]) => b - a <= CHUNK_BYTES)).toBe(true);
    expect(slices.map(([a]) => a)).toEqual([0, CHUNK_BYTES, CHUNK_BYTES * 2, CHUNK_BYTES * 3]);
    expect(slices.some(([a, b]) => a === 0 && b === size)).toBe(false);
  });

  it('reports monotonic progress that reaches the total', async () => {
    const t = await testBlobs();
    const size = CHUNK_BYTES * 2 + 1;
    const seen: number[] = [];
    await t.blobs.attach(new Blob([pattern(size) as BlobPart]), { space: SPACE, obj: 'o1', onProgress: (d, total) => (expect(total).toBe(size), seen.push(d)) });
    expect(seen).toEqual([CHUNK_BYTES, CHUNK_BYTES * 2, size]);
  });

  it('deletes the partial and rejects when aborted mid-way', async () => {
    const t = await testBlobs();
    const ctl = new AbortController();
    const p = t.blobs.attach(new Blob([pattern(CHUNK_BYTES * 3) as BlobPart]), { space: SPACE, obj: 'o1', signal: ctl.signal, onProgress: () => ctl.abort() });
    await expect(p).rejects.toThrow();
    expect(await t.storage.usedBytes()).toBe(0);
    expect(await t.storage.getMeta('partials')).toEqual({});
    const pre = new AbortController();
    pre.abort();
    await expect(t.blobs.attach(new Blob([pattern(5) as BlobPart]), { space: SPACE, obj: 'o1', signal: pre.signal })).rejects.toThrow();
  });

  it('rejects an oversize file with BlobTooLargeError before reading any chunk', async () => {
    const t = await testBlobs({ maxBlobBytes: 1000 });
    const { source, slices } = spySource(2000);
    const err = await t.blobs.attach(source, { space: SPACE, obj: 'o1' }).catch((e) => e);
    expect(err).toBeInstanceOf(BlobTooLargeError);
    expect(err).toMatchObject({ size: 2000, limit: 1000 });
    expect(slices).toEqual([]);
    expect(await t.storage.usedBytes()).toBe(0);
  });

  it('rejects with BlobKeyError when this device holds no key for the scope, leaving nothing behind', async () => {
    const t = await testBlobs();
    t.provider.denyWrites();
    await expect(t.blobs.attach(new Blob([pattern(5) as BlobPart]), { space: SPACE, obj: 'o1' })).rejects.toBeInstanceOf(BlobKeyError);
    expect(await t.storage.usedBytes()).toBe(0);
  });

  it('keeps one copy when identical content is attached twice (same ID, one stored chunk set)', async () => {
    const t = await testBlobs();
    const a = await t.blobs.attach(new Blob([pattern(CHUNK_BYTES + 3) as BlobPart]), { space: SPACE, obj: 'o1' });
    const used = await t.storage.usedBytes();
    const b = await t.blobs.attach(new Blob([pattern(CHUNK_BYTES + 3) as BlobPart]), { space: SPACE, obj: 'o2' });
    expect(b.id).toBe(a.id);
    expect(await t.storage.usedBytes()).toBe(used);
    let n = 0;
    for await (const _ of t.storage.listBlobs()) n++;
    expect(n).toBe(1);
  });

  it('emits blob:attached', async () => {
    const t = await testBlobs();
    const seen: string[] = [];
    t.blobs.on('blob:attached', (e) => seen.push(e.ref.id));
    const ref = await t.blobs.attach(new Blob([pattern(9) as BlobPart]), { space: SPACE, obj: 'o1' });
    expect(seen).toEqual([ref.id]);
  });

  it('deletes partial attaches older than an hour at startup and keeps younger ones', async () => {
    const { createBlobs, createMemoryBlobStorage } = await import('../../src');
    const { createTestCore } = await import('@sync/testkit');
    const { vectorProvider } = await import('../helpers');
    const tc = await createTestCore();
    const storage = createMemoryBlobStorage();
    await storage.putChunk('partial-old', 0, new Uint8Array(10));
    await storage.putChunk('partial-new', 0, new Uint8Array(10));
    await storage.setMeta('partials', { 'partial-old': tc.clock.now() - 2 * 3_600_000, 'partial-new': tc.clock.now() - 60_000 });
    await createBlobs({ core: tc.core, keyProvider: await vectorProvider(), storage, config: { now: tc.clock.now } });
    expect(await storage.presentChunks('partial-old')).toEqual([]);
    expect(await storage.presentChunks('partial-new')).toEqual([0]);
    expect(await storage.getMeta('partials')).toEqual({ 'partial-new': tc.clock.now() - 60_000 });
  });
});
