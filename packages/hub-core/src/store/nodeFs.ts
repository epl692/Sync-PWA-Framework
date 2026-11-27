/** FsPort over Node's `fs` (desktop Hub and tests). Imported only from Node code, never from the browser bundle. */

import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FsPort } from './fsPort';

export function createNodeFs(root: string): FsPort {
  const p = (path: string) => join(root, path);
  const missing = (e: unknown) => (e as { code?: string }).code === 'ENOENT';
  return {
    async read(path) {
      try {
        return new Uint8Array(await readFile(p(path)));
      } catch (e) {
        if (missing(e)) return undefined;
        throw e;
      }
    },
    async readRange(path, offset, length) {
      let fh;
      try {
        fh = await open(p(path), 'r');
      } catch (e) {
        if (missing(e)) return undefined;
        throw e;
      }
      try {
        const buf = new Uint8Array(length);
        const { bytesRead } = await fh.read(buf, 0, length, offset);
        return buf.slice(0, bytesRead);
      } finally {
        await fh.close();
      }
    },
    async writeAtomic(path, bytes) {
      const target = p(path);
      await mkdir(dirname(target), { recursive: true });
      const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, bytes);
      await rename(tmp, target);
    },
    async append(path, bytes) {
      const target = p(path);
      await mkdir(dirname(target), { recursive: true });
      const fh = await open(target, 'a');
      try {
        await fh.write(bytes);
      } finally {
        await fh.close();
      }
    },
    async list(dir) {
      try {
        return (await readdir(p(dir), { withFileTypes: true })).filter((d) => d.isFile() && !d.name.includes('.tmp-')).map((d) => d.name);
      } catch (e) {
        if (missing(e)) return [];
        throw e;
      }
    },
    async listDirs(dir) {
      try {
        return (await readdir(p(dir), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
      } catch (e) {
        if (missing(e)) return [];
        throw e;
      }
    },
    async remove(path) {
      await rm(p(path), { force: true });
    },
    async removeDir(dir) {
      await rm(p(dir), { recursive: true, force: true });
    },
    async size(path) {
      try {
        return (await stat(p(path))).size;
      } catch (e) {
        if (missing(e)) return undefined;
        throw e;
      }
    },
  };
}
