// Spec 005 T101: the Hub's stored data and codes stay readable across versions, and unknown versions are refused rather than damaged.
import { describe, expect, it } from 'vitest';
import { ServeCodeError, createMemoryFs, createSegmentStore, parseServeCode, SegmentFormatError } from '../src';

const b64u = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('serve codes', () => {
  const mk = (o: Record<string, unknown>) => 'syncserve:1:' + b64u(JSON.stringify({ v: 1, kind: 'serve', space: 'A'.repeat(26), epoch: 1, accessPublic: b64u(String.fromCharCode(...new Uint8Array(32))), createdAt: 1, ...o }));
  it('ignores fields it does not know (a newer app may add them)', () => {
    expect(parseServeCode(mk({ futureField: { x: 1 } }), 0)).toMatchObject({ kind: 'serve', epoch: 1 });
  });
  it('refuses a code of a newer major version with a clear error', () => {
    try {
      parseServeCode('syncserve:2:abc', 0);
      throw new Error('should not parse');
    } catch (e) {
      expect((e as ServeCodeError).code).toBe('unsupported-version');
    }
  });
});

describe('segment files', () => {
  it('an unknown segment version is refused and left untouched', async () => {
    const fs = createMemoryFs();
    const s = createSegmentStore(fs);
    await s.open();
    await s.addPacket('S', 'a:1', new Uint8Array(10).fill(1), 1_700_000_000_000);
    const path = [...fs.files.keys()].find((k) => k.endsWith('.seg'))!;
    fs.files.get(path)![5] = 2;
    const before = fs.files.get(path)!.slice();
    await expect(createSegmentStore(fs).open()).rejects.toBeInstanceOf(SegmentFormatError);
    expect(fs.files.get(path)).toEqual(before);
  });
  it('a file that is not a segment at all is refused too', async () => {
    const fs = createMemoryFs();
    await fs.writeAtomic('packets/S/20260101.seg', new TextEncoder().encode('not a segment file at all'));
    await expect(createSegmentStore(fs).open()).rejects.toBeInstanceOf(SegmentFormatError);
  });
});
