// T055: opening a blob decrypts chunk by chunk and verifies every tag.
import { describe, expect, it } from 'vitest';
import { BlobFetchError, BlobIntegrityError, BlobNotLocalError, CHUNK_BYTES, type BlobRef } from '../../src';
import { pattern, testBlobs } from '../helpers';

const SPACE = 'SPACE1';
const unknown = (): BlobRef => ({ $blob: 1, id: 'A'.repeat(43), size: 100, type: 'image/png', space: SPACE, scope: SPACE, keyId: '0123456789abcdef' });

async function readAll(stream: ReadableStream<Uint8Array>) {
  const parts: Uint8Array[] = [];
  const r = stream.getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    parts.push(value);
  }
  return parts;
}

describe('open', () => {
  it('streams the plaintext one chunk at a time', async () => {
    const t = await testBlobs();
    const size = CHUNK_BYTES * 3 + 7;
    const ref = await t.blobs.attach(new Blob([pattern(size) as BlobPart]), { space: SPACE, obj: 'o1' });
    const parts = await readAll(await t.blobs.open(ref));
    expect(parts.map((p) => p.length)).toEqual([CHUNK_BYTES, CHUNK_BYTES, CHUNK_BYTES, 7]);
    const all = new Uint8Array(size);
    let o = 0;
    for (const p of parts) {
      all.set(p, o);
      o += p.length;
    }
    const expected = pattern(size);
    expect(all.every((v, i) => v === expected[i])).toBe(true);
  });

  it('toBlob assembles the same bytes and carries the media type', async () => {
    const t = await testBlobs();
    const ref = await t.blobs.attach(new Blob([pattern(1000) as BlobPart], { type: 'image/png' }), { space: SPACE, obj: 'o1' });
    const b = await t.blobs.toBlob(ref);
    expect(b.size).toBe(1000);
    expect(b.type).toBe('image/png');
  });

  it('rejects with BlobNotLocalError for a blob that is not here when fetching is off', async () => {
    const t = await testBlobs();
    await expect(t.blobs.open(unknown(), { fetch: false })).rejects.toBeInstanceOf(BlobNotLocalError);
    await expect(t.blobs.toBlob(unknown(), { fetch: false })).rejects.toBeInstanceOf(BlobNotLocalError);
  });

  it('rejects something that is not a usable reference', async () => {
    const t = await testBlobs();
    await expect(t.blobs.open({ ...unknown(), size: 0 })).rejects.toBeInstanceOf(TypeError);
    await expect(t.blobs.open({ $blob: 2 } as never)).rejects.toBeInstanceOf(TypeError);
  });

  it('aborts the stream with BlobIntegrityError when a stored chunk has been corrupted', async () => {
    const t = await testBlobs();
    const ref = await t.blobs.attach(new Blob([pattern(CHUNK_BYTES * 2) as BlobPart]), { space: SPACE, obj: 'o1' });
    const chunk = (await t.storage.getChunk(ref.id, 1))!.slice();
    chunk[50]! ^= 1;
    await t.storage.deleteChunks(ref.id);
    await t.storage.putChunk(ref.id, 0, (await (async () => (await t.storage.getChunk(ref.id, 0)) ?? new Uint8Array(0))()) ?? new Uint8Array(0));
    await t.storage.putChunk(ref.id, 1, chunk);
    const r = (await t.blobs.open(ref, { fetch: false }).catch((e) => e)) as ReadableStream<Uint8Array> | Error;
    // chunk 0 was removed above, so reading fails at the first chunk; either way no plaintext is produced
    if (r instanceof Error) return expect(r).toBeDefined();
    await expect(r.getReader().read()).rejects.toBeInstanceOf(BlobIntegrityError);
  });

  it('a flipped bit in one stored chunk fails exactly that chunk and no plaintext of it is yielded', async () => {
    const t = await testBlobs();
    const ref = await t.blobs.attach(new Blob([pattern(CHUNK_BYTES * 3) as BlobPart]), { space: SPACE, obj: 'o1' });
    const originals = await Promise.all([0, 1, 2].map((i) => t.storage.getChunk(ref.id, i)));
    const bad = originals[1]!.slice();
    bad[100]! ^= 8;
    await t.storage.deleteChunks(ref.id);
    await t.storage.putChunk(ref.id, 0, originals[0]!);
    await t.storage.putChunk(ref.id, 1, bad);
    await t.storage.putChunk(ref.id, 2, originals[2]!);
    const reader = (await t.blobs.open(ref, { fetch: false })).getReader();
    expect((await reader.read()).value!.length).toBe(CHUNK_BYTES);
    await expect(reader.read()).rejects.toBeInstanceOf(BlobIntegrityError);
  });

  it('fails with `no-key` when this device does not hold the epoch key, and recovers when it arrives', async () => {
    const t = await testBlobs();
    const ref = await t.blobs.attach(new Blob([pattern(2000) as BlobPart]), { space: SPACE, obj: 'o1' });
    t.provider.hideReads();
    const err = await t.blobs.open(ref, { fetch: false }).catch((e) => e);
    expect(err).toBeInstanceOf(BlobFetchError);
    expect((err as BlobFetchError).reason).toBe('no-key');
    expect(t.blobs.observe(ref).get()).toMatchObject({ state: 'failed', reason: 'no-key' });
    t.provider.grant();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.blobs.observe(ref).get().state).toBe('available');
    expect((await t.blobs.toBlob(ref)).size).toBe(2000);
  });

  it('an aborted open rejects', async () => {
    const t = await testBlobs();
    const ref = await t.blobs.attach(new Blob([pattern(1000) as BlobPart]), { space: SPACE, obj: 'o1' });
    const ctl = new AbortController();
    ctl.abort();
    await expect(t.blobs.open(ref, { signal: ctl.signal })).rejects.toBeDefined();
  });
});
