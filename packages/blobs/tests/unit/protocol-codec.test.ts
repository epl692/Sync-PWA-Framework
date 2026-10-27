// T015: lane message codec (contracts/blob-protocol.md). Decoding hostile bytes never throws.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeMessage, encodeMessage, type LaneMsg } from '../../src/protocol/codec';

const id = (n: number) => Buffer.alloc(32, n).toString('base64url');
const stored = Uint8Array.from({ length: 300 }, (_, i) => i % 256);
const ranges = (n: number): Array<[number, number]> => Array.from({ length: n }, (_, i) => [i * 3, i * 3 + 1]);

const messages: LaneMsg[] = [
  { type: 'hello', v: 1, window: 8, maxChunks: 4096, serve: true },
  { type: 'offer', space: 'SPACEAAAAAAAAAAAAAAAAAAAAA', id: id(1), size: 1234 },
  { type: 'get', id: id(2), manifest: true, space: 'SPACEAAAAAAAAAAAAAAAAAAAAA', ranges: ranges(3) },
  { type: 'manifest', id: id(3), manifest: Uint8Array.from([1, 2, 3, 4]) },
  { type: 'chunk', id: id(4), index: 77, stored },
  { type: 'miss', id: id(5), ranges: ranges(2) },
  { type: 'stored', id: id(6) },
  { type: 'reject', id: id(7), reason: 'quota' },
  { type: 'cancel', id: id(8) },
];

describe('round trip', () => {
  it.each(messages.map((m) => [m.type, m] as const))('%s', (_t, m) => {
    const bytes = encodeMessage(m);
    expect(bytes[0]).toBe(0xb1);
    const d = decodeMessage(bytes);
    expect(d.ok).toBe(true);
    if (d.ok && 'msg' in d) expect(d.msg).toEqual(m);
  });

  it.each([0, 1, 4096])('get and miss carry %i ranges', (n) => {
    for (const m of [
      { type: 'get', id: id(2), manifest: false, space: 's', ranges: ranges(n) } as LaneMsg,
      { type: 'miss', id: id(2), ranges: ranges(n) } as LaneMsg,
    ]) {
      const d = decodeMessage(encodeMessage(m));
      expect(d.ok && 'msg' in d && d.msg).toEqual(m);
    }
  });
});

describe('rejects malformed messages', () => {
  const bad = (bytes: Uint8Array) => {
    const d = decodeMessage(bytes);
    expect(d.ok).toBe(false);
  };
  it('anything that does not start with the lane magic', () => {
    bad(Uint8Array.from([0x7b, 1, 2]));
    bad(new Uint8Array(0));
  });
  it('truncated bodies', () => {
    for (const m of messages) {
      const bytes = encodeMessage(m);
      if (m.type === 'hello' || m.type === 'offer' || m.type === 'reject') continue; // JSON truncation is covered below
      bad(bytes.slice(0, bytes.length - 1 < 2 ? 2 : Math.min(bytes.length - 1, m.type === 'chunk' ? 20 : 34)));
    }
  });
  it('a body with a bad id length', () => {
    bad(Uint8Array.from([0xb1, 0x07, 1, 2, 3]));
    bad(Uint8Array.from([0xb1, 0x09, ...new Array(31).fill(1)]));
  });
  it('nRanges larger than the body', () => {
    const b = encodeMessage({ type: 'miss', id: id(1), ranges: ranges(2) }).slice();
    new DataView(b.buffer, b.byteOffset).setUint16(34, 500);
    bad(b);
  });
  it('more than 4096 ranges', () => {
    const b = encodeMessage({ type: 'miss', id: id(1), ranges: ranges(4097) });
    bad(b);
  });
  it('ranges with lo above hi', () => {
    const b = encodeMessage({ type: 'miss', id: id(1), ranges: [[5, 9]] }).slice();
    new DataView(b.buffer, b.byteOffset).setUint32(36, 20); // lo = 20 > hi = 9
    bad(b);
  });
  it('JSON bodies over 4 KiB, bad JSON, and wrong field types', () => {
    const big = Uint8Array.from([0xb1, 0x02, ...new TextEncoder().encode(JSON.stringify({ space: 'x'.repeat(5000), id: id(1), size: 1 }))]);
    bad(big);
    bad(Uint8Array.from([0xb1, 0x01, ...new TextEncoder().encode('{nope')]));
    bad(Uint8Array.from([0xb1, 0x02, ...new TextEncoder().encode(JSON.stringify({ space: 5, id: id(1), size: 1 }))]));
    bad(Uint8Array.from([0xb1, 0x08, ...new TextEncoder().encode(JSON.stringify({ id: id(1), reason: 'because' }))]));
  });
  it('a chunk message with no data', () => {
    bad(Uint8Array.from([0xb1, 0x05, ...new Array(32).fill(1), 0, 0, 0, 1]));
  });
});

describe('forward compatibility', () => {
  it('reports an unknown type byte as ignorable, not as an error', () => {
    expect(decodeMessage(Uint8Array.from([0xb1, 0x7e, 1, 2, 3]))).toEqual({ ok: true, unknown: 0x7e });
  });
});

describe('robustness', () => {
  it('never throws on arbitrary bytes that start with the magic (property)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 600 }), fc.integer({ min: 0, max: 20 }), (tail, type) => {
        const bytes = Uint8Array.from([0xb1, type, ...tail]);
        expect(() => decodeMessage(bytes)).not.toThrow();
      }),
      { numRuns: 2000 },
    );
  });
  it('round-trips any chunk index and payload (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), fc.uint8Array({ minLength: 1, maxLength: 400 }), (index, data) => {
        const m: LaneMsg = { type: 'chunk', id: id(9), index, stored: data };
        const d = decodeMessage(encodeMessage(m));
        expect(d.ok && 'msg' in d && d.msg).toEqual(m);
      }),
      { numRuns: 300 },
    );
  });
});
