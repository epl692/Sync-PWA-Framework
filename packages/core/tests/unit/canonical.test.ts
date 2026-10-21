import { describe, expect, it } from 'vitest';
import { b64urlDecode, b64urlEncode, canonicalBytes, canonicalString, parseJsonBytes } from '../../src/packet/canonical';

describe('canonical JSON', () => {
  it('sorts object keys at every level and emits no whitespace', () => {
    expect(canonicalString({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('produces identical bytes regardless of key insertion order', () => {
    const x = canonicalBytes({ one: 1, two: 2, three: { a: 1, b: 2 } });
    const y = canonicalBytes({ three: { b: 2, a: 1 }, two: 2, one: 1 });
    expect(Array.from(x)).toEqual(Array.from(y));
  });

  it('rejects NaN and Infinity', () => {
    expect(() => canonicalString({ n: NaN })).toThrow();
    expect(() => canonicalString([Infinity])).toThrow();
    expect(() => canonicalString({ n: -Infinity })).toThrow();
  });

  it('omits undefined properties like JSON does', () => {
    expect(canonicalString({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('rejects unsupported values', () => {
    expect(() => canonicalString({ f: () => 1 })).toThrow();
    expect(() => canonicalString({ big: 1n })).toThrow();
  });

  it('round-trips through parseJsonBytes', () => {
    const v = { s: 'héllo ☃', n: [1, 2.5, -3], t: true, z: null };
    expect(parseJsonBytes(canonicalBytes(v))).toEqual(v);
  });

  it('throws on malformed bytes', () => {
    expect(() => parseJsonBytes(new Uint8Array([0xff, 0xfe]))).toThrow();
    expect(() => parseJsonBytes(new TextEncoder().encode('{bad'))).toThrow();
  });
});

describe('base64url', () => {
  it('round-trips arbitrary bytes without padding', () => {
    for (let len = 0; len < 40; len++) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 37 + len) & 0xff);
      const s = b64urlEncode(bytes);
      expect(s).not.toMatch(/[=+/]/);
      expect(Array.from(b64urlDecode(s))).toEqual(Array.from(bytes));
    }
  });

  it('rejects characters outside the alphabet', () => {
    expect(() => b64urlDecode('ab+/')).toThrow();
    expect(() => b64urlDecode('ab=')).toThrow();
  });
});
