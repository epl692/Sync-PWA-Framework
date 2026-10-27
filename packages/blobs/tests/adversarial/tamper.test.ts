// T047: hostile and faulty peers: tampered manifests and chunks, repeat offenders, a blob that verifies but cannot decrypt.
import { describe, expect, it } from 'vitest';
import { laneType } from '@sync/testkit';
import {
  BlobFetchError,
  BlobIntegrityError,
  CHUNK_BYTES,
  encodeManifest,
  manifestId,
  sealChunk,
  unhex,
} from '../../src';
import { SPACE, pattern, plainPeers, vectorProvider } from '../helpers';

const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

describe('tampered chunks', () => {
  it('discards a chunk with a flipped bit, counts it, and re-requests it from the other source (US2.3)', async () => {
    const t = await plainPeers(['a', 'b', 'c']);
    const size = CHUNK_BYTES * 3 + 10;
    const ref = await t.attach('a', pattern(size));
    expect((await t.attach('c', pattern(size))).id).toBe(ref.id); // deterministic: both hold the same blob
    const rejected: string[] = [];
    t.engines.b!.on('blob:rejected', (e) => rejected.push(`${e.peer}:${e.reason}`));
    t.faults.tamper('chunk', { times: 1 });
    await t.engines.b!.request(ref);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatch(/digest/);
    expect(same(await bytesOf(await t.engines.b!.toBlob(ref)), pattern(size))).toBe(true);
    await t.close();
  }, 60_000);

  it('re-requests from the same peer after a back-off when it is the only source', async () => {
    const t = await plainPeers(['a', 'b']);
    const ref = await t.attach('a', pattern(CHUNK_BYTES * 2));
    const rejected: string[] = [];
    t.engines.b!.on('blob:rejected', (e) => rejected.push(e.reason));
    t.faults.tamper('chunk', { times: 1 });
    await t.engines.b!.request(ref);
    expect(rejected).toHaveLength(1);
    expect(t.engines.b!.observe(ref).get().state).toBe('available');
    await t.close();
  }, 60_000);

  it('gives up on a peer that fails three times: the blob fails with `verification`, nothing tampered is stored, and the peer is not asked again', async () => {
    const t = await plainPeers(['a', 'b']);
    const ref = await t.attach('a', pattern(CHUNK_BYTES * 2));
    t.faults.tamper('chunk', { times: 1000 });
    const err = await t.engines.b!.request(ref).catch((e) => e);
    expect(err).toBeInstanceOf(BlobFetchError);
    expect((err as BlobFetchError).reason).toBe('verification');
    expect(t.engines.b!.observe(ref).get()).toMatchObject({ state: 'failed', reason: 'verification' });
    expect(await t.storages.b!.presentChunks(ref.id)).toEqual([]);

    const gets = t.faults.count('get', 'b');
    const again = t.engines.b!.request(ref);
    await new Promise((r) => setTimeout(r, 300));
    expect(t.faults.count('get', 'b')).toBe(gets); // not asked again this session
    expect(t.engines.b!.observe(ref).get()).toMatchObject({ state: 'missing', reason: 'no-source' });
    t.engines.b!.cancel(ref);
    await again.catch(() => undefined);
    await t.close();
  }, 60_000);

  it('never stores a chunk of the wrong length, out of range, or unsolicited', async () => {
    const t = await plainPeers(['a', 'b']);
    const ref = await t.attach('a', pattern(CHUNK_BYTES + 5));
    // a chunk shortened by one byte, in transit
    t.faults.corruptNext((b) => laneType(b) === 'chunk', (b) => b.slice(0, b.length - 1), 1);
    const rejected: string[] = [];
    t.engines.b!.on('blob:rejected', (e) => rejected.push(e.reason));
    await t.engines.b!.request(ref);
    expect(rejected.some((r) => /length/.test(r))).toBe(true);
    expect(await t.storages.b!.presentChunks(ref.id)).toEqual([0, 1]);
    await t.close();
  }, 60_000);
});

describe('tampered manifests', () => {
  it('rejects a manifest that does not hash to the blob ID and stores no chunk until a valid one arrives', async () => {
    const t = await plainPeers(['a', 'b', 'c']);
    const ref = await t.attach('a', pattern(CHUNK_BYTES * 2));
    await t.attach('c', pattern(CHUNK_BYTES * 2));
    const rejected: string[] = [];
    t.engines.b!.on('blob:rejected', (e) => rejected.push(e.reason));
    t.faults.tamper('manifest', { times: 1 });
    await t.engines.b!.request(ref);
    expect(rejected.some((r) => /hash/.test(r))).toBe(true);
    expect(t.engines.b!.observe(ref).get().state).toBe('available');
    await t.close();
  }, 60_000);

  it('fails with `verification` and stores nothing when every manifest it is offered is corrupt', async () => {
    const t = await plainPeers(['a', 'b']);
    const ref = await t.attach('a', pattern(CHUNK_BYTES * 2));
    t.faults.tamper('manifest', { times: 1000 });
    const err = await t.engines.b!.request(ref).catch((e) => e);
    expect((err as BlobFetchError).reason).toBe('verification');
    expect(await t.storages.b!.presentChunks(ref.id)).toEqual([]);
    expect(await t.storages.b!.getBlob(ref.id)).toBeUndefined();
    await t.close();
  }, 60_000);
});

describe('a blob that verifies but cannot be decrypted', () => {
  it('fails at open with BlobIntegrityError and yields no plaintext (a valid digest does not make it genuine)', async () => {
    const t = await plainPeers(['evil', 'b']);
    const real = await (await vectorProvider()).forWrite(SPACE, 'o1');
    // chunks sealed under the WRONG keys, but with a manifest whose digests match them and the real scope and key ID
    const wrong = {
      scopeId: real.scopeId,
      keyId: real.keyId,
      enc: await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
      mac: await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    };
    const size = 100;
    const sealed = await sealChunk(wrong, size, 0, pattern(size));
    const manifest = encodeManifest({ scopeId: real.scopeId, keyId: unhex(real.keyId), size, digests: [sealed.digest] });
    const id = await manifestId(manifest);
    const now = Date.now();
    await t.storages.evil!.putChunk(id, 0, sealed.stored);
    await t.storages.evil!.putBlob({ id, manifest, space: SPACE, scope: SPACE, keyId: real.keyId, size, type: 'text/plain', origin: 'local', replicas: [], pinned: false, complete: true, createdAt: now, lastAccessAt: now, unreferencedAt: null });
    const ref = { $blob: 1 as const, id, size, type: 'text/plain', space: SPACE, scope: SPACE, keyId: real.keyId };

    await t.engines.b!.request(ref); // the digests check out, so it downloads
    const stream = await t.engines.b!.open(ref);
    const reader = stream.getReader();
    await expect(reader.read()).rejects.toBeInstanceOf(BlobIntegrityError);
    await t.close();
  }, 60_000);
});
