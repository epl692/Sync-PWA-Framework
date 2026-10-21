// T070: length-prefixed, CRC-checked framing for transports with small message limits.
import { describe, expect, it } from 'vitest';
import { FrameError, Reassembler, chunk } from '@sync/core';

const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);
const eq = (a: Uint8Array | undefined, b: Uint8Array) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);

describe('framing', () => {
  it('sends a small message as a single frame and reassembles it', () => {
    const msg = bytes(100);
    const frames = chunk(msg, 1024);
    expect(frames).toHaveLength(1);
    expect(eq(new Reassembler().push(frames[0]!), msg)).toBe(true);
  });

  it('splits a large message and respects the frame size limit', () => {
    const msg = bytes(100_000);
    const frames = chunk(msg, 1000);
    expect(frames.length).toBeGreaterThan(100);
    for (const f of frames) expect(f.length).toBeLessThanOrEqual(1000);
    const r = new Reassembler();
    let out: Uint8Array | undefined;
    for (const f of frames) out = r.push(f) ?? out;
    expect(eq(out, msg)).toBe(true);
  });

  it('handles an empty message', () => {
    const frames = chunk(new Uint8Array(0), 100);
    expect(new Reassembler().push(frames[0]!)).toEqual(new Uint8Array(0));
  });

  it('reassembles frames that arrive out of order and with duplicates', () => {
    const msg = bytes(5000);
    const frames = chunk(msg, 400);
    const shuffled = [...frames].reverse();
    shuffled.splice(2, 0, frames[0]!, frames[3]!); // duplicates
    const r = new Reassembler();
    const done: Uint8Array[] = [];
    for (const f of shuffled) {
      const m = r.push(f);
      if (m) done.push(m);
    }
    expect(done).toHaveLength(1);
    expect(eq(done[0], msg)).toBe(true);
  });

  it('keeps interleaved messages apart', () => {
    const m1 = bytes(3000, 1);
    const m2 = bytes(3000, 2);
    const f1 = chunk(m1, 500);
    const f2 = chunk(m2, 500);
    const r = new Reassembler();
    const done: Uint8Array[] = [];
    for (let i = 0; i < Math.max(f1.length, f2.length); i++) {
      for (const f of [f2[i], f1[i]]) if (f) { const m = r.push(f); if (m) done.push(m); }
    }
    expect(done.map((d) => d[0]).sort()).toEqual([m1[0], m2[0]].sort());
    expect(done.some((d) => eq(d, m1))).toBe(true);
    expect(done.some((d) => eq(d, m2))).toBe(true);
  });

  it('rejects a corrupt frame without disturbing later messages', () => {
    const r = new Reassembler();
    const bad = chunk(bytes(50), 100)[0]!.slice();
    bad[bad.length - 6] ^= 0xff; // flip payload bits: CRC no longer matches
    expect(() => r.push(bad)).toThrow(FrameError);
    const good = bytes(60, 9);
    expect(eq(r.push(chunk(good, 100)[0]!), good)).toBe(true);
  });

  it('rejects truncated frames, junk, and unknown versions', () => {
    const r = new Reassembler();
    const f = chunk(bytes(200), 100)[0]!;
    expect(() => r.push(f.slice(0, f.length - 3))).toThrow(FrameError);
    expect(() => r.push(new Uint8Array([1, 2, 3]))).toThrow(FrameError);
    expect(() => r.push(new Uint8Array(0))).toThrow(FrameError);
    const v9 = f.slice();
    v9[0] = 9;
    expect(() => r.push(v9)).toThrow(FrameError);
  });

  it('refuses a message whose declared size exceeds the limit', () => {
    const frames = chunk(bytes(10_000), 100);
    const r = new Reassembler({ maxMessageBytes: 1000 });
    expect(() => r.push(frames[0]!)).toThrow(FrameError);
  });

  it('drops the oldest incomplete messages when too many are pending', () => {
    const r = new Reassembler({ maxPending: 2 });
    const msgs = [bytes(300, 1), bytes(300, 2), bytes(300, 3)].map((m) => chunk(m, 100));
    for (const frames of msgs) r.push(frames[0]!); // start three, none finished
    // the first message was evicted, so its remaining frames never complete it
    let completed = 0;
    for (const f of msgs[0]!.slice(1)) if (r.push(f)) completed++;
    expect(completed).toBe(0);
    for (const f of msgs[2]!.slice(1)) if (r.push(f)) completed++;
    expect(completed).toBe(1);
  });
});
