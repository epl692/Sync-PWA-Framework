// T023: chunk sealing and opening against the known-answer vectors, tamper detection, nonce uniqueness.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CHUNK_BYTES } from '../../src/format';
import { openChunk, sealChunk, sha256, type ChunkKeys } from '../../src/crypto/chunk';
import { BlobIntegrityError } from '../../src/types';

const vec = JSON.parse(readFileSync(join(__dirname, '..', 'vectors', 'blobs.json'), 'utf8')) as {
  cases: Array<{ name: string; size: number; chunks: Array<{ index: number; plainLength: number; nonce: string; storedLength: number; storedSha256: string; storedPrefix: string; stored?: string }> }>;
};
const kv = JSON.parse(readFileSync(join(__dirname, '..', 'vectors', 'keys.json'), 'utf8')) as Record<string, string>;
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16)));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const pattern = (size: number, from = 0) => Uint8Array.from({ length: size }, (_, i) => ((i + from) * 7 + 3) & 0xff);

async function keysFrom(encHex: string, macHex: string, scopeHex = kv.scopeId!, keyId = kv.keyId!): Promise<ChunkKeys> {
  return {
    scopeId: fromHex(scopeHex),
    keyId,
    enc: await crypto.subtle.importKey('raw', fromHex(encHex), 'AES-GCM', false, ['encrypt', 'decrypt']),
    mac: await crypto.subtle.importKey('raw', fromHex(macHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
  };
}
const vectorKeys = () => keysFrom(kv.encKey!, kv.macKey!);

describe('known-answer vectors', () => {
  for (const c of vec.cases) {
    it(`seals ${c.name} to the vector bytes and opens it back`, async () => {
      const keys = await vectorKeys();
      const plain = pattern(c.size);
      for (const ch of c.chunks) {
        const p = plain.subarray(ch.index * CHUNK_BYTES, ch.index * CHUNK_BYTES + ch.plainLength);
        const sealed = await sealChunk(keys, c.size, ch.index, p);
        expect(toHex(sealed.stored.subarray(0, 12))).toBe(ch.nonce);
        expect(sealed.stored.length).toBe(ch.storedLength);
        expect(toHex(sealed.stored.subarray(0, 48))).toBe(ch.storedPrefix);
        expect(toHex(sealed.digest)).toBe(ch.storedSha256);
        if (ch.stored) expect(toHex(sealed.stored)).toBe(ch.stored);
        const opened = await openChunk(keys, c.size, ch.index, sealed.stored);
        expect(toHex(opened)).toBe(toHex(p));
      }
    });
  }
});

describe('tamper detection', () => {
  const size = 1000;
  const plain = pattern(size);
  it('fails to open when any bit of the stored chunk changes (nonce, ciphertext or tag)', async () => {
    const keys = await vectorKeys();
    const { stored } = await sealChunk(keys, size, 0, plain);
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: stored.length - 1 }), fc.integer({ min: 0, max: 7 }), async (byte, bit) => {
        const bad = stored.slice();
        bad[byte]! ^= 1 << bit;
        await expect(openChunk(keys, size, 0, bad)).rejects.toBeInstanceOf(BlobIntegrityError);
      }),
      { numRuns: 120 },
    );
  });

  it('fails when the index, size, scope or key ID differ from what the chunk was sealed under', async () => {
    const keys = await vectorKeys();
    const { stored } = await sealChunk(keys, size, 0, plain);
    await expect(openChunk(keys, size, 1, stored)).rejects.toBeInstanceOf(BlobIntegrityError);
    await expect(openChunk(keys, size + 1, 0, stored)).rejects.toBeInstanceOf(BlobIntegrityError);
    await expect(openChunk({ ...keys, scopeId: fromHex('00'.repeat(16)) }, size, 0, stored)).rejects.toBeInstanceOf(BlobIntegrityError);
    await expect(openChunk({ ...keys, keyId: '0000000000000000' }, size, 0, stored)).rejects.toBeInstanceOf(BlobIntegrityError);
  });

  it('cannot be opened with the keys of another epoch', async () => {
    const keys = await vectorKeys();
    const other = await keysFrom('11'.repeat(32), '22'.repeat(32));
    const { stored } = await sealChunk(keys, size, 0, plain);
    await expect(openChunk(other, size, 0, stored)).rejects.toBeInstanceOf(BlobIntegrityError);
  });

  it('rejects a stored chunk that is too short to hold a nonce and a tag', async () => {
    const keys = await vectorKeys();
    await expect(openChunk(keys, size, 0, new Uint8Array(27))).rejects.toBeInstanceOf(BlobIntegrityError);
  });
});

describe('determinism and nonce uniqueness', () => {
  it('gives identical bytes for identical plaintext, key and index (this is what makes dedup possible)', async () => {
    const keys = await vectorKeys();
    const a = await sealChunk(keys, 500, 0, pattern(500));
    const b = await sealChunk(keys, 500, 0, pattern(500));
    expect(toHex(a.stored)).toBe(toHex(b.stored));
    expect(toHex(a.digest)).toBe(toHex(b.digest));
  });

  it('never repeats a nonce for a different index or different plaintext (property)', async () => {
    const keys = await vectorKeys();
    const seen = new Map<string, string>();
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 50 }), fc.uint8Array({ minLength: 1, maxLength: 64 }), async (index, plain) => {
        const { stored } = await sealChunk(keys, 64 * 51, index, plain);
        const nonce = toHex(stored.subarray(0, 12));
        const content = `${index}:${toHex(plain)}`;
        const prev = seen.get(nonce);
        if (prev !== undefined) expect(prev).toBe(content);
        seen.set(nonce, content);
      }),
      { numRuns: 300 },
    );
  });

  it('computes SHA-256 like the platform', async () => {
    expect(toHex(await sha256(new Uint8Array(0)))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
