import { describe, expect, it } from 'vitest';
import { WORDLIST, fingerprintGroups, fingerprintWords } from '../../src/link';

const fp = Uint8Array.from('fe812c12f3ab4ce6ac5db69ac352f906cb1b11ef43fb33e252ef7ff552263889'.match(/../g)!.map((h) => parseInt(h, 16)));

const EXPECT_GROUPS = '72as-yext-vngo-nlc5-w2nm-guxz-a3fr-wepp';
const EXPECT_WORDS = ['vortex', 'mosaic', 'clover', 'blanket'];

describe('fingerprint display', () => {
  it('the word list has 256 distinct lowercase words', () => {
    expect(WORDLIST).toHaveLength(256);
    expect(new Set(WORDLIST).size).toBe(256);
    for (const w of WORDLIST) expect(w).toMatch(/^[a-z]+$/);
  });
  it('groups are 8 groups of 4 base32 characters (known answer from RFC 4648 base32 of the first 20 bytes)', () => {
    const g = fingerprintGroups(fp);
    expect(g).toMatch(/^([a-z2-7]{4}-){7}[a-z2-7]{4}$/);
    expect(g).toBe(EXPECT_GROUPS);
  });
  it('words come from the first 4 bytes', () => {
    expect(fingerprintWords(fp)).toEqual(EXPECT_WORDS);
    expect(fingerprintWords(fp)).toHaveLength(4);
  });
  it('rejects too-short input', () => {
    expect(() => fingerprintGroups(new Uint8Array(19))).toThrow(RangeError);
    expect(() => fingerprintWords(new Uint8Array(3))).toThrow(RangeError);
  });
});
