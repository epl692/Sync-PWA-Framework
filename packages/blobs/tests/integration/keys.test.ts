// T052: encryption keys across rotation, removal and override shares, with real secure devices (FR-002, spec edge cases).
import { describe, expect, it } from 'vitest';
import { createBlobPeers, waitFor, type BlobPeers } from '@sync/testkit';
import { BlobFetchError, CHUNK_BYTES, createBlobs, createMemoryBlobStorage, type Blobs, type MemoryBlobStorage } from '../../src';
import { pattern } from '../helpers';

const stores = new Map<string, MemoryBlobStorage>();
const engineOn = (p: BlobPeers, name: string): Promise<Blobs> => {
  const n = p.node(name);
  const storage = createMemoryBlobStorage();
  stores.set(name, storage);
  return createBlobs({ core: n.core, keys: n.spaces.blobKeys, storage });
};
const contains = (hay: Uint8Array, needle: Uint8Array) => {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
};
const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

describe('rotation and removal', () => {
  it('a member with all epochs opens blobs from before and after a rotation; a removed member cannot decrypt the new one', async () => {
    const p = await createBlobPeers(['a', 'b', 'c']);
    const [A, B, C] = [await engineOn(p, 'a'), await engineOn(p, 'b'), await engineOn(p, 'c')];
    await waitFor(() => p.node('a').core.peers().filter((x) => x.lanes.length && x.spaces.length).length === 2, 15_000, 'lane peers');

    const before = pattern(CHUNK_BYTES + 100, 1);
    const x = await A.attach(new Blob([before as BlobPart]), { space: p.space, obj: 'o-before' });
    await C.request(x); // c downloads it while still a member
    expect(same(await bytesOf(await C.toBlob(x)), before)).toBe(true);

    await p.node('a').spaces.remove(p.space, p.node('c').spaces.session()!.user); // rotation: a new epoch key
    await waitFor(async () => (await p.node('a').spaces.list())[0]!.currentEpoch >= 1, 15_000, 'rotated');
    await p.settle(5);

    const after = pattern(CHUNK_BYTES + 200, 2);
    const y = await A.attach(new Blob([after as BlobPart]), { space: p.space, obj: 'o-after' });
    expect(y.keyId).not.toBe(x.keyId); // the new epoch's key

    // b holds every epoch: both open
    await B.request(x);
    await B.request(y);
    expect(same(await bytesOf(await B.toBlob(x)), before)).toBe(true);
    expect(same(await bytesOf(await B.toBlob(y)), after)).toBe(true);

    // c keeps what it already downloaded, and can still be served the new ciphertext, but never decrypts it
    expect(same(await bytesOf(await C.toBlob(x)), before)).toBe(true);
    const err = await C.request(y).catch((e) => e);
    expect(err).toBeInstanceOf(BlobFetchError);
    expect((err as BlobFetchError).reason).toBe('no-key');
    expect(C.observe(y).get()).toMatchObject({ state: 'failed', reason: 'no-key' });
    await expect(C.open(y, { fetch: false })).rejects.toMatchObject({ reason: 'no-key' });
    await p.close();
  }, 120_000);
});

describe('override shares', () => {
  it('a Space member outside the share can fetch the ciphertext but never read it; a share member can', async () => {
    const p = await createBlobPeers(['owner', 'editor', 'viewer']);
    const [O, E, V] = [await engineOn(p, 'owner'), await engineOn(p, 'editor'), await engineOn(p, 'viewer')];
    const viewerUser = p.node('viewer').spaces.session()!.user;
    const { object, share } = await p.node('editor').spaces.createInShare(p.space, 'gift', { idea: 'surprise party' }, [{ user: viewerUser, role: 'viewer' }]);
    await p.settle(4);

    const secret = pattern(CHUNK_BYTES * 2 + 33, 7);
    const ref = await E.attach(new Blob([secret as BlobPart]), { space: p.space, obj: object.id });
    expect(ref.scope).toBe(share.shareId); // encrypted with the share key, not the Space key
    await p.node('editor').core.update(object.id, { photo: ref as never });
    await waitFor(() => p.node('editor').core.peers().filter((x) => x.lanes.length && x.spaces.length).length === 2, 15_000, 'lane peers');

    await V.request(ref);
    expect(same(await bytesOf(await V.toBlob(ref)), secret)).toBe(true);

    const outsider = await O.request(ref).catch((e) => e);
    expect(outsider).toBeInstanceOf(BlobFetchError);
    expect((outsider as BlobFetchError).reason).toBe('no-key');
    await expect(O.open(ref, { fetch: false })).rejects.toMatchObject({ reason: 'no-key' });
    // the outsider holds the ciphertext only: no stored chunk contains a run of the plaintext
    const marker = secret.subarray(1000, 1032);
    for (const i of await stores.get('owner')!.presentChunks(ref.id)) expect(contains((await stores.get('owner')!.getChunk(ref.id, i))!, marker)).toBe(false);
    await p.close();
  }, 120_000);

  it('a blob attached before its object moved into a share stays readable under the Space key (documented parity with packets)', async () => {
    const p = await createBlobPeers(['owner', 'editor', 'viewer']);
    const [O, E] = [await engineOn(p, 'owner'), await engineOn(p, 'editor')];
    await engineOn(p, 'viewer');
    const note = await p.node('editor').core.create(p.space, 'note', { x: 1 });
    const bytes = pattern(5000, 3);
    const ref = await E.attach(new Blob([bytes as BlobPart]), { space: p.space, obj: note.id });
    expect(ref.scope).toBe(p.space);
    await p.node('editor').spaces.share(note.id, [{ user: p.node('viewer').spaces.session()!.user, role: 'viewer' }]);
    await p.settle(4);
    await waitFor(() => p.node('owner').core.peers().some((x) => x.lanes.length && x.spaces.length), 15_000, 'lane peer');
    await O.request(ref); // the owner is not in the share, yet reads the old attachment
    expect(same(await bytesOf(await O.toBlob(ref)), bytes)).toBe(true);
    await p.close();
  }, 120_000);
});
