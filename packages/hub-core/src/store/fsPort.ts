/** The few file operations the segment store needs. Node `fs`, a Capacitor filesystem, and memory all implement it (spec 005 T087). */

export interface FsPort {
  /** Whole file, or undefined if it does not exist. */
  read(path: string): Promise<Uint8Array | undefined>;
  /** `length` bytes from `offset` (fewer at the end of the file), or undefined if the file does not exist. */
  readRange(path: string, offset: number, length: number): Promise<Uint8Array | undefined>;
  /** Replace a file atomically (write a temporary file, then rename): a crash leaves the old or the new content, never a mix. */
  writeAtomic(path: string, bytes: Uint8Array): Promise<void>;
  /** Append to a file, creating it (and its folders) if needed. */
  append(path: string, bytes: Uint8Array): Promise<void>;
  /** File names (not paths) directly inside `dir`; empty if there is none. */
  list(dir: string): Promise<string[]>;
  /** Sub-folder names directly inside `dir`. */
  listDirs(dir: string): Promise<string[]>;
  remove(path: string): Promise<void>;
  /** Remove a folder and everything in it. */
  removeDir(dir: string): Promise<void>;
  size(path: string): Promise<number | undefined>;
}

/** An in-memory FsPort with fault injection, for tests. */
export interface MemoryFs extends FsPort {
  files: Map<string, Uint8Array>;
  /** Cut the last `n` bytes off a file, as if the process died halfway through an append. */
  tear(path: string, n: number): void;
}

export function createMemoryFs(): MemoryFs {
  const files = new Map<string, Uint8Array>();
  const norm = (p: string) => p.replace(/\/+/g, '/').replace(/\/$/, '');
  const under = (dir: string) => norm(dir) + '/';
  return {
    files,
    async read(path) {
      return files.get(norm(path))?.slice();
    },
    async readRange(path, offset, length) {
      return files.get(norm(path))?.slice(offset, offset + length);
    },
    async writeAtomic(path, bytes) {
      files.set(norm(path), bytes.slice());
    },
    async append(path, bytes) {
      const p = norm(path);
      const cur = files.get(p) ?? new Uint8Array(0);
      const next = new Uint8Array(cur.length + bytes.length);
      next.set(cur);
      next.set(bytes, cur.length);
      files.set(p, next);
    },
    async list(dir) {
      const d = under(dir);
      return [...files.keys()].filter((k) => k.startsWith(d) && !k.slice(d.length).includes('/')).map((k) => k.slice(d.length));
    },
    async listDirs(dir) {
      const d = under(dir);
      return [...new Set([...files.keys()].filter((k) => k.startsWith(d) && k.slice(d.length).includes('/')).map((k) => k.slice(d.length).split('/')[0]!))];
    },
    async remove(path) {
      files.delete(norm(path));
    },
    async removeDir(dir) {
      const d = under(dir);
      for (const k of [...files.keys()]) if (k.startsWith(d)) files.delete(k);
    },
    async size(path) {
      return files.get(norm(path))?.length;
    },
    tear(path, n) {
      const p = norm(path);
      const cur = files.get(p);
      if (cur) files.set(p, cur.slice(0, Math.max(0, cur.length - n)));
    },
  };
}
