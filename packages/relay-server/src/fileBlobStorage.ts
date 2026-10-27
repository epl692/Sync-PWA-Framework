/**
 * A Node file-system BlobStorage for the relay (spec 004, R-1): ciphertext chunks, verified manifests and small JSON
 * records on disk, so blobs far larger than memory survive a restart. Layout:
 *
 *   <dir>/<hh>/<hex(id)>/record.json     the record without its manifest
 *   <dir>/<hh>/<hex(id)>/manifest.bin
 *   <dir>/<hh>/<hex(id)>/refs.json
 *   <dir>/<hh>/<hex(id)>/chunks/<00000>.bin
 *   <dir>/meta/<hex(key)>.json
 *
 * Names are the hex of the UTF-8 bytes of the ID, so they are safe on case-insensitive file systems (blob IDs are
 * case-sensitive base64url). Writes go to a temporary file and are renamed into place.
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StorageQuotaError } from '@sync/core';
import type { BlobStorage, StoredBlob } from '@sync/blobs';

const hexName = (s: string) => Buffer.from(s, 'utf8').toString('hex');
const pad = (i: number) => String(i).padStart(5, '0');

type Record_ = Omit<StoredBlob, 'manifest'>;

export interface FileBlobStorage extends BlobStorage {
  readonly dir: string;
}

export async function createFileBlobStorage(dir: string): Promise<FileBlobStorage> {
  await mkdir(join(dir, 'meta'), { recursive: true });
  let used = 0;
  const known = new Set<string>(); // blob IDs with a record on disk, for listBlobs

  const blobDir = (id: string) => {
    const h = hexName(id);
    return join(dir, h.slice(0, 2), h);
  };
  const atomic = async (path: string, data: Uint8Array | string) => {
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await writeFile(tmp, data);
      // Windows refuses to rename over a file another handle has open (EPERM/EBUSY/EACCES): the reader is gone in a moment
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(tmp, path);
          return;
        } catch (e) {
          const code = (e as { code?: string })?.code;
          if (attempt >= 8 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
          await new Promise((r) => setTimeout(r, 10 * (attempt + 1)));
        }
      }
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw (e as { code?: string })?.code === 'ENOSPC' ? new StorageQuotaError() : e;
    }
  };
  const readJson = async <T>(path: string): Promise<T | undefined> => {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch {
      return undefined;
    }
  };
  const dropChunks = async (id: string): Promise<number> => {
    let freed = 0;
    for (const f of await chunkFiles(id)) {
      const p = join(blobDir(id), 'chunks', f);
      freed += await stat(p).then((s) => s.size, () => 0);
      await rm(p, { force: true });
    }
    used -= freed;
    return freed;
  };
  const chunkFiles = async (id: string): Promise<string[]> => readdir(join(blobDir(id), 'chunks')).catch(() => []);

  // index what is already on disk (a restart)
  for (const shard of await readdir(dir).catch(() => [])) {
    if (shard === 'meta') continue;
    for (const h of await readdir(join(dir, shard)).catch(() => [])) {
      const rec = await readJson<Record_>(join(dir, shard, h, 'record.json'));
      if (rec) known.add(rec.id);
      for (const f of await readdir(join(dir, shard, h, 'chunks')).catch(() => [])) used += (await stat(join(dir, shard, h, 'chunks', f))).size;
    }
  }

  const load = async (id: string): Promise<StoredBlob | undefined> => {
    const rec = await readJson<Record_>(join(blobDir(id), 'record.json'));
    if (!rec) return undefined;
    const manifest = await readFile(join(blobDir(id), 'manifest.bin')).catch(() => undefined);
    return manifest ? { ...rec, manifest: new Uint8Array(manifest) } : undefined;
  };

  return {
    dir,

    getBlob: load,
    async putBlob(rec) {
      await mkdir(blobDir(rec.id), { recursive: true });
      const { manifest, ...rest } = rec;
      // a manifest is immutable (the blob ID is its hash): written once, never replaced
      if (!(await stat(join(blobDir(rec.id), 'manifest.bin')).then(() => true, () => false))) await atomic(join(blobDir(rec.id), 'manifest.bin'), manifest);
      await atomic(join(blobDir(rec.id), 'record.json'), JSON.stringify(rest));
      known.add(rec.id);
    },
    async *listBlobs(o) {
      const all: StoredBlob[] = [];
      for (const id of known) {
        const b = await load(id);
        if (b) all.push(b);
      }
      const key = o?.orderBy ?? 'lastAccessAt';
      all.sort((a, b) => a[key] - b[key] || (a.id < b.id ? -1 : 1));
      yield* o?.limit !== undefined ? all.slice(0, o.limit) : all;
    },
    async deleteBlob(id) {
      await dropChunks(id);
      await rm(blobDir(id), { recursive: true, force: true });
      known.delete(id);
    },

    async putChunk(id, index, stored) {
      const path = join(blobDir(id), 'chunks', `${pad(index)}.bin`);
      if (await stat(path).then(() => true, () => false)) return; // idempotent
      await mkdir(join(blobDir(id), 'chunks'), { recursive: true });
      await atomic(path, stored);
      used += stored.length;
    },
    async getChunk(id, index) {
      try {
        return new Uint8Array(await readFile(join(blobDir(id), 'chunks', `${pad(index)}.bin`)));
      } catch {
        return undefined;
      }
    },
    async presentChunks(id) {
      return (await chunkFiles(id)).filter((f) => f.endsWith('.bin')).map((f) => Number(f.slice(0, -4))).sort((a, b) => a - b);
    },
    deleteChunks: dropChunks,
    async moveChunks(from, to) {
      if (from === to) return;
      for (const f of await chunkFiles(from)) {
        const src = join(blobDir(from), 'chunks', f);
        const dst = join(blobDir(to), 'chunks', f);
        const size = await stat(src).then((s) => s.size, () => 0);
        await mkdir(join(blobDir(to), 'chunks'), { recursive: true });
        if (await stat(dst).then(() => true, () => false)) {
          await rm(src, { force: true }); // the destination already holds it: drop the duplicate
          used -= size;
        } else {
          await rename(src, dst);
        }
      }
    },

    async getRefs(id) {
      return (await readJson<string[]>(join(blobDir(id), 'refs.json'))) ?? [];
    },
    async setRefs(id, objects) {
      if (!objects.length) return void (await rm(join(blobDir(id), 'refs.json'), { force: true }));
      await mkdir(blobDir(id), { recursive: true });
      await atomic(join(blobDir(id), 'refs.json'), JSON.stringify(objects));
    },
    getMeta: <T>(key: string) => readJson<T>(join(dir, 'meta', `${hexName(key)}.json`)),
    async setMeta(key, value) {
      await atomic(join(dir, 'meta', `${hexName(key)}.json`), JSON.stringify(value));
    },

    async usedBytes() {
      return used;
    },
    async close() {
      // nothing is held open
    },
  };
}
