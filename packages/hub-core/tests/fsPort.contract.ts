/** fsPortContract(): behavior every FsPort must have (spec 005 T087). */
import { describe, expect, it } from 'vitest';
import type { FsPort } from '../src/store/fsPort';

const bytes = (...n: number[]) => Uint8Array.from(n);

export function fsPortContract(name: string, make: () => Promise<{ fs: FsPort; cleanup(): Promise<void> }>): void {
  describe(`FsPort contract: ${name}`, () => {
    const run = async (fn: (fs: FsPort) => Promise<void>) => {
      const { fs, cleanup } = await make();
      try {
        await fn(fs);
      } finally {
        await cleanup();
      }
    };

    it('reads nothing from a file that does not exist', () => run(async (fs) => {
      expect(await fs.read('a/b')).toBeUndefined();
      expect(await fs.readRange('a/b', 0, 4)).toBeUndefined();
      expect(await fs.size('a/b')).toBeUndefined();
      expect(await fs.list('a')).toEqual([]);
      expect(await fs.listDirs('a')).toEqual([]);
      await fs.remove('a/b');
      await fs.removeDir('a');
    }));

    it('append creates folders and files, and keeps adding', () => run(async (fs) => {
      await fs.append('x/y/log', bytes(1, 2));
      await fs.append('x/y/log', bytes(3));
      expect(Array.from((await fs.read('x/y/log'))!)).toEqual([1, 2, 3]);
      expect(await fs.size('x/y/log')).toBe(3);
    }));

    it('readRange returns the bytes asked for and fewer at the end', () => run(async (fs) => {
      await fs.append('f', bytes(10, 11, 12, 13, 14));
      expect(Array.from((await fs.readRange('f', 1, 3))!)).toEqual([11, 12, 13]);
      expect(Array.from((await fs.readRange('f', 3, 10))!)).toEqual([13, 14]);
      expect(Array.from((await fs.readRange('f', 9, 2))!)).toEqual([]);
    }));

    it('writeAtomic replaces the whole file and leaves no temporary files behind', () => run(async (fs) => {
      await fs.writeAtomic('d/f', bytes(1, 2, 3));
      await fs.writeAtomic('d/f', bytes(9));
      expect(Array.from((await fs.read('d/f'))!)).toEqual([9]);
      expect(await fs.list('d')).toEqual(['f']);
    }));

    it('lists files and folders separately, and removes them', () => run(async (fs) => {
      await fs.append('r/one', bytes(1));
      await fs.append('r/two', bytes(2));
      await fs.append('r/sub/three', bytes(3));
      expect((await fs.list('r')).sort()).toEqual(['one', 'two']);
      expect(await fs.listDirs('r')).toEqual(['sub']);
      await fs.remove('r/one');
      expect(await fs.list('r')).toEqual(['two']);
      await fs.removeDir('r');
      expect(await fs.list('r')).toEqual([]);
      expect(await fs.listDirs('r')).toEqual([]);
    }));
  });
}
