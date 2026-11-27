// Spec 005 link/1 frame layout (contracts/bluetooth-link.md#frames).
import { describe, expect, it } from 'vitest';
import {
  FrameType,
  Reassembler,
  StrikeWindow,
  decodeFrame,
  encodeFrame,
  splitMessage,
  type Frame,
} from '../../src/link/frames';

describe('frame byte layout', () => {
  it('byte 0 = type(2) | stream | START | END | 3 reserved bits; byte 1 = seq', () => {
    // DATA, stream 1, START, END, seq 7, payload "ab"
    const f: Frame = { type: FrameType.DATA, stream: 1, start: true, end: true, seq: 7, payload: Uint8Array.of(0x61, 0x62) };
    expect(Array.from(encodeFrame(f))).toEqual([0b00_1_1_1_000, 7, 0x61, 0x62]);
    // ACK on stream 0, seq byte, payload = highest in-order seq
    expect(Array.from(encodeFrame({ type: FrameType.ACK, stream: 0, start: false, end: false, seq: 0, payload: Uint8Array.of(15) }))).toEqual([0b01_0_0_0_000, 0, 15]);
    // PROBE
    expect(encodeFrame({ type: FrameType.PROBE, stream: 0, start: false, end: false, seq: 0, payload: new Uint8Array(62) })[0]).toBe(0b10_000000);
  });

  it('decodes what it encodes and ignores reserved bits on receipt', () => {
    const f: Frame = { type: FrameType.DATA, stream: 0, start: true, end: false, seq: 200, payload: Uint8Array.of(1, 2, 3) };
    expect(decodeFrame(encodeFrame(f))).toEqual(f);
    const raw = encodeFrame(f);
    raw[0] |= 0b111; // reserved bits set by a newer peer
    expect(decodeFrame(raw)).toEqual(f);
  });

  it('rejects frames shorter than 2 bytes and the reserved type', () => {
    expect(decodeFrame(new Uint8Array(0))).toBeNull();
    expect(decodeFrame(Uint8Array.of(0))).toBeNull();
    expect(decodeFrame(Uint8Array.of(0b11_000000, 0))).toBeNull();
  });

  it('encoding always sends reserved bits as 0', () => {
    for (const stream of [0, 1] as const) {
      const b = encodeFrame({ type: FrameType.DATA, stream, start: true, end: true, seq: 0, payload: new Uint8Array(1) });
      expect(b[0]! & 0b111).toBe(0);
    }
  });
});

describe('splitMessage and Reassembler', () => {
  const rea = (over: Partial<ConstructorParameters<typeof Reassembler>[0]> = {}) => new Reassembler({ maxMessageBytes: 1000, ...over });

  it('a single-frame message has START and END', () => {
    const frames = splitMessage(Uint8Array.of(1, 2, 3), 20, 0, 0);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ start: true, end: true, seq: 0 });
  });

  it('splits to frameBytes including the 2-byte header, with consecutive wrapping seq', () => {
    const frames = splitMessage(new Uint8Array(100), 20, 0, 254);
    expect(frames.every((f) => encodeFrame(f).length <= 20)).toBe(true);
    expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => (254 + i) % 256));
    expect(frames[0]!.start).toBe(true);
    expect(frames.at(-1)!.end).toBe(true);
    expect(frames.slice(1).every((f) => !f.start)).toBe(true);
  });

  it('reassembles in order', () => {
    const msg = Uint8Array.from({ length: 300 }, (_, i) => i % 251);
    const r = rea();
    let out: Uint8Array | undefined;
    for (const f of splitMessage(msg, 23, 0, 5)) out = r.push(f, 0).message ?? out;
    expect(out).toEqual(msg);
  });

  it('a gap aborts only the current message and the next message still arrives', () => {
    const r = rea();
    const a = splitMessage(new Uint8Array(100).fill(1), 20, 0, 0);
    const b = splitMessage(new Uint8Array(40).fill(2), 20, 0, a.length);
    const results = [a[0]!, a[2]!, a[3]!, ...a.slice(4)].map((f) => r.push(f, 0)); // a[1] lost
    expect(results.some((x) => x.message)).toBe(false);
    expect(results.some((x) => x.error === 'frame-gap')).toBe(true);
    let got: Uint8Array | undefined;
    for (const f of b) got = r.push(f, 0).message ?? got;
    expect(got).toEqual(new Uint8Array(40).fill(2));
  });

  it('a duplicated frame aborts the message rather than corrupting it', () => {
    const r = rea();
    const a = splitMessage(new Uint8Array(60).fill(9), 20, 0, 0);
    const seen = [a[0]!, a[1]!, a[1]!, a[2]!, ...a.slice(3)].map((f) => r.push(f, 0));
    expect(seen.some((x) => x.message)).toBe(false);
    expect(seen.some((x) => x.error)).toBe(true);
  });

  it('START inside a message aborts the partial and starts the new one', () => {
    const r = rea();
    const a = splitMessage(new Uint8Array(60).fill(1), 20, 0, 0);
    const b = splitMessage(Uint8Array.of(7, 7), 20, 0, 1); // seq 1 = the next expected, with START
    r.push(a[0]!, 0);
    const res = r.push(b[0]!, 0);
    expect(res.error).toBe('start-in-message');
    expect(res.message).toEqual(Uint8Array.of(7, 7));
  });

  it('the two streams are independent', () => {
    const r = rea();
    const lane = splitMessage(new Uint8Array(100).fill(5), 20, 1, 0);
    const ctrl = splitMessage(Uint8Array.of(1, 2, 3), 20, 0, 0);
    let got: Uint8Array | undefined;
    for (let i = 0; i < lane.length - 1; i++) r.push(lane[i]!, 0);
    got = r.push(ctrl[0]!, 0).message; // a control message completes in the middle of a lane message
    expect(got).toEqual(Uint8Array.of(1, 2, 3));
    expect(r.push(lane.at(-1)!, 0).message).toEqual(new Uint8Array(100).fill(5));
  });

  it('aborts a message larger than maxMessageBytes + 24', () => {
    const r = rea({ maxMessageBytes: 100 });
    let err: string | undefined;
    for (const f of splitMessage(new Uint8Array(300), 20, 0, 0)) err = r.push(f, 0).error ?? err;
    expect(err).toBe('oversize');
  });

  it('drops a partial message older than the timeout (30 s)', () => {
    const r = rea();
    const a = splitMessage(new Uint8Array(60), 20, 0, 0);
    r.push(a[0]!, 1000);
    expect(r.expire(1000 + 29_999)).toEqual([]);
    expect(r.expire(1000 + 30_000)).toEqual([0]);
    // after expiry the continuation is not a message and is reported, not delivered
    const res = r.push(a[1]!, 40_000);
    expect(res.message).toBeUndefined();
    expect(res.error).toBeDefined();
  });
});

describe('StrikeWindow', () => {
  it('trips on the 3rd strike within 10 s and forgets older ones', () => {
    const w = new StrikeWindow(3, 10_000);
    expect(w.record(0)).toBe(false);
    expect(w.record(5_000)).toBe(false);
    expect(w.record(9_999)).toBe(true);
    const w2 = new StrikeWindow(3, 10_000);
    w2.record(0);
    w2.record(5_000);
    expect(w2.record(10_001)).toBe(false); // the first aged out
  });
});
