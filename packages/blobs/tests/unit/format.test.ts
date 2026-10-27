// T022: manifest codec, blob ID and reference validation, against the known-answer vectors (contracts/blob-format.md).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeManifest, encodeManifest, extractRefs, manifestId, validateRef, CHUNK_BYTES, type BlobRef } from '../../src/format';

const vec = JSON.parse(readFileSync(join(__dirname, '..', 'vectors', 'blobs.json'), 'utf8')) as {
  cases: Array<{ name: string; size: number; manifest: string; id: string; chunks: Array<{ storedSha256: string }> }>;
};
const keys = JSON.parse(readFileSync(join(__dirname, '..', 'vectors', 'keys.json'), 'utf8')) as Record<string, string>;
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16)));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

describe('manifest', () => {
  it.each(vec.cases)('encodes, hashes and decodes $name exactly as the vector says', async (c) => {
    const bytes = encodeManifest({
      scopeId: fromHex(keys.scopeId),
      keyId: fromHex(keys.keyId),
      size: c.size,
      digests: c.chunks.map((k) => fromHex(k.storedSha256)),
    });
    expect(toHex(bytes)).toBe(c.manifest);
    expect(await manifestId(bytes)).toBe(c.id);
    expect(c.id).toHaveLength(43);
    const d = decodeManifest(bytes);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.manifest.size).toBe(c.size);
      expect(d.manifest.chunkBytes).toBe(CHUNK_BYTES);
      expect(d.manifest.digests).toHaveLength(c.chunks.length);
      expect(toHex(d.manifest.scopeId)).toBe(keys.scopeId);
      expect(toHex(d.manifest.keyId)).toBe(keys.keyId);
    }
  });

  const good = fromHex(vec.cases[2]!.manifest);
  const mutate = (f: (b: Uint8Array) => void): Uint8Array => {
    const b = good.slice();
    f(b);
    return b;
  };
  const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

  it.each([
    ['fmt other than 1', mutate((b) => (b[0] = 2))],
    ['chunkBytes other than 262144', mutate((b) => view(b).setUint32(33, 1024))],
    ['size 0', mutate((b) => view(b).setBigUint64(25, 0n))],
    ['n inconsistent with size', mutate((b) => view(b).setUint32(37, 5))],
    ['truncated digest list', good.slice(0, good.length - 1)],
    ['extra trailing byte', new Uint8Array([...good, 0])],
    ['empty', new Uint8Array(0)],
  ])('rejects %s', (_n, bytes) => {
    expect(decodeManifest(bytes).ok).toBe(false);
  });

  it('rejects a manifest over the configured maximum blob size and one with more than 65535 chunks', () => {
    expect(decodeManifest(good, { maxBlobBytes: 1000 }).ok).toBe(false);
    const huge = mutate((b) => {
      view(b).setBigUint64(25, BigInt(CHUNK_BYTES) * 70000n);
      view(b).setUint32(37, 70000);
    });
    expect(decodeManifest(huge, { maxBlobBytes: 2 ** 40 }).ok).toBe(false);
  });
});

const ref = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  $blob: 1,
  id: vec.cases[0]!.id,
  size: 1,
  type: 'image/jpeg',
  space: 'SPACEAAAAAAAAAAAAAAAAAAAAA',
  scope: 'SPACEAAAAAAAAAAAAAAAAAAAAA',
  keyId: keys.keyId,
  name: 'photo.jpg',
  ...over,
});

describe('validateRef', () => {
  it('accepts a good reference and returns it typed', () => {
    const r = validateRef(ref());
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.ref as BlobRef).size).toBe(1);
  });

  it('accepts a reference without a name and ignores unknown extra properties (forward compatibility)', () => {
    expect(validateRef(ref({ name: undefined, future: 'x' })).ok).toBe(true);
  });

  it.each([
    ['not an object', 'x'],
    ['null', null],
    ['an array', []],
    ['missing marker', ref({ $blob: undefined })],
    ['id too short', ref({ id: 'abc' })],
    ['id with a bad character', ref({ id: '!'.repeat(43) })],
    ['id with a non-canonical last character', ref({ id: 'A'.repeat(42) + 'B' })],
    ['size zero', ref({ size: 0 })],
    ['size negative', ref({ size: -1 })],
    ['size not an integer', ref({ size: 1.5 })],
    ['size as a string', ref({ size: '10' })],
    ['type without a slash', ref({ type: 'jpeg' })],
    ['type with spaces', ref({ type: 'image/j peg' })],
    ['type longer than 127', ref({ type: 'a/' + 'b'.repeat(130) })],
    ['keyId not 16 hex', ref({ keyId: 'ABC' })],
    ['name longer than 255', ref({ name: 'n'.repeat(256) })],
    ['empty space', ref({ space: '' })],
    ['empty scope', ref({ scope: '' })],
  ])('rejects %s', (_n, v) => {
    const r = validateRef(v);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.unsupported).toBeFalsy();
  });

  it('rejects a size over the configured maximum', () => {
    expect(validateRef(ref({ size: 2000 }), { maxBlobBytes: 1000 }).ok).toBe(false);
  });

  it('reports a future $blob version as unsupported, not invalid', () => {
    const r = validateRef(ref({ $blob: 2 }));
    expect(r).toMatchObject({ ok: false, unsupported: true });
  });
});

describe('extractRefs', () => {
  const a = ref();
  const b = ref({ id: vec.cases[1]!.id });
  it('finds references at the top level, nested in objects and inside lists, and stops at depth 4', () => {
    expect(extractRefs(a)).toEqual([a]);
    expect(extractRefs({ x: { y: a } })).toEqual([a]);
    expect(extractRefs([a, 'x', [b]])).toEqual([a, b]);
    expect(extractRefs({ l1: { l2: { l3: { l4: { l5: a } } } } })).toEqual([]);
    expect(extractRefs('plain')).toEqual([]);
    expect(extractRefs(null)).toEqual([]);
  });
  it('does not descend into a reference', () => {
    expect(extractRefs({ $blob: 1, id: 'x', inner: a })).toHaveLength(1);
  });
});
