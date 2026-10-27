// Verification rules (blob-format.md#verification) as pure functions: what a receiver, or a relay, accepts.
import { describe, expect, it } from 'vitest';
import { bytesEqual, decodeManifest, encodeManifest, manifestId, sealChunk, CHUNK_BYTES } from '../../src';
import { verifyChunk, verifyManifest } from '../../src/transfer/verify';
import { blobVectors, fromHex, keyVectors, pattern, vectorProvider } from '../helpers';

const c = blobVectors.cases[2]!; // 262145 bytes: two chunks
const manifestBytes = fromHex(c.manifest);
const ref = { id: c.id, size: c.size, keyId: keyVectors.keyId! };
const opts = { maxBlobBytes: 1 << 30 };

describe('verifyManifest', () => {
  it('accepts the vector manifest', async () => {
    const v = await verifyManifest(ref, manifestBytes, opts);
    expect(v.ok).toBe(true);
  });

  it('accepts it with a matching scope ID and rejects a different one', async () => {
    expect((await verifyManifest(ref, manifestBytes, { ...opts, scopeId: fromHex(keyVectors.scopeId!) })).ok).toBe(true);
    const v = await verifyManifest(ref, manifestBytes, { ...opts, scopeId: new Uint8Array(16) });
    expect(v).toMatchObject({ ok: false });
    if (!v.ok) expect(v.reason).toMatch(/scope/);
  });

  it('rejects a manifest that does not hash to the blob ID (a single flipped bit anywhere)', async () => {
    for (let i = 0; i < manifestBytes.length; i += 7) {
      const bad = manifestBytes.slice();
      bad[i]! ^= 1;
      const v = await verifyManifest(ref, bad, opts);
      expect(v.ok, `byte ${i}`).toBe(false);
    }
  });

  it('rejects a well-formed manifest whose key ID or size differs from the reference', async () => {
    const other = encodeManifest({ scopeId: fromHex(keyVectors.scopeId!), keyId: fromHex('0000000000000000'), size: c.size, digests: c.chunks.map((k) => fromHex(k.storedSha256)) });
    const id = await manifestId(other);
    expect(await verifyManifest({ id, size: c.size, keyId: keyVectors.keyId! }, other, opts)).toMatchObject({ ok: false });
    expect(await verifyManifest({ ...ref, size: c.size + 1 }, manifestBytes, opts)).toMatchObject({ ok: false });
  });

  it('rejects a manifest over the configured maximum size', async () => {
    expect((await verifyManifest(ref, manifestBytes, { maxBlobBytes: 1000 })).ok).toBe(false);
  });
});

describe('verifyChunk', () => {
  async function fixture() {
    const d = decodeManifest(manifestBytes);
    if (!d.ok) throw new Error('vector manifest');
    return d.manifest;
  }

  it('accepts a chunk that matches its digest and has the right length', async () => {
    const m = await fixture();
    const provider = await vectorProvider();
    const k = (await provider.forWrite('SPACE1', 'o'))!;
    const sealed = await sealChunk(k, c.size, 0, pattern(CHUNK_BYTES));
    expect(bytesEqual(sealed.digest, m.digests[0]!)).toBe(true);
    expect(await verifyChunk(m, 0, sealed.stored)).toEqual({ ok: true });
  });

  it('rejects an index out of range, a wrong length, and a wrong digest', async () => {
    const m = await fixture();
    const provider = await vectorProvider();
    const k = (await provider.forWrite('SPACE1', 'o'))!;
    const { stored } = await sealChunk(k, c.size, 0, pattern(CHUNK_BYTES));
    expect(await verifyChunk(m, 2, stored)).toMatchObject({ ok: false });
    expect(await verifyChunk(m, -1, stored)).toMatchObject({ ok: false });
    expect(await verifyChunk(m, 0, stored.subarray(0, stored.length - 1))).toMatchObject({ ok: false });
    expect(await verifyChunk(m, 1, stored)).toMatchObject({ ok: false }); // chunk 0's bytes offered as chunk 1 (wrong length too)
    const flipped = stored.slice();
    flipped[100]! ^= 4;
    const v = await verifyChunk(m, 0, flipped);
    expect(v).toMatchObject({ ok: false });
    if (!v.ok) expect(v.reason).toMatch(/digest/);
  });
});
