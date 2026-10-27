// T065: the Node file-system BlobStorage against the shared contract suite, plus its on-disk safety properties.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { blobStorageContract } from '@sync/testkit';
import { createFileBlobStorage } from '../src';

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});
const fresh = async () => {
  const d = await mkdtemp(join(tmpdir(), 'blob-fs-'));
  roots.push(d);
  return d;
};

blobStorageContract('file system (relay)', {
  async create() {
    const dir = await fresh();
    const storage = await createFileBlobStorage(dir);
    return { storage, reopen: async () => createFileBlobStorage(dir) };
  },
});

describe('file layout', () => {
  it('names files by the hex of the ID so IDs that differ only by case never collide (case-insensitive file systems)', async () => {
    const dir = await fresh();
    const s = await createFileBlobStorage(dir);
    await s.putChunk('AbC', 0, new Uint8Array([1]));
    await s.putChunk('abc', 0, new Uint8Array([2, 2]));
    expect(await s.getChunk('AbC', 0)).toEqual(new Uint8Array([1]));
    expect(await s.getChunk('abc', 0)).toEqual(new Uint8Array([2, 2]));
    const shards = (await readdir(dir)).filter((x) => x !== 'meta');
    expect(shards.every((x) => /^[0-9a-f]{2}$/.test(x))).toBe(true);
  });

  it('leaves no temporary files behind and recounts used bytes at startup', async () => {
    const dir = await fresh();
    const s = await createFileBlobStorage(dir);
    await s.putChunk('x', 0, new Uint8Array(1000));
    await s.putChunk('x', 1, new Uint8Array(500));
    const again = await createFileBlobStorage(dir);
    expect(await again.usedBytes()).toBe(1500);
    const walk = async (d: string): Promise<string[]> => (await readdir(d, { withFileTypes: true })).flatMap((e) => (e.isDirectory() ? [] : [e.name]));
    const hexDir = (await readdir(dir)).find((x) => x !== 'meta')!;
    const blob = (await readdir(join(dir, hexDir)))[0]!;
    expect((await walk(join(dir, hexDir, blob, 'chunks'))).every((f) => f.endsWith('.bin'))).toBe(true);
  });
});
