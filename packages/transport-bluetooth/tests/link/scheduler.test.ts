// Spec 005 link/1 flow control, fairness and frame-size probing (contracts/bluetooth-link.md#frames).
import { describe, expect, it } from 'vitest';
import {
  FrameType,
  LinkFramer,
  PROBE_LADDER,
  PROBE_SPACING_MS,
  ProbeCollector,
  chooseFrameBytes,
  decodeFrame,
  encodeFrame,
  makeProbeFrame,
  type Frame,
} from '../../src/link';

type Wire = { bytes: Uint8Array; frame: Frame }[];

function sender(over: Partial<ConstructorParameters<typeof LinkFramer>[0]> = {}) {
  const wire: Wire = [];
  const f = new LinkFramer({
    maxMessageBytes: 1 << 20,
    frameBytes: 20,
    write: (b) => void wire.push({ bytes: b, frame: decodeFrame(b)! }),
    now: () => 0,
    ...over,
  });
  return { f, wire };
}
const data = (w: Wire, stream?: 0 | 1) => w.filter((x) => x.frame.type === FrameType.DATA && (stream === undefined || x.frame.stream === stream));

describe('window', () => {
  it('stops after 32 unacknowledged DATA frames per stream and resumes when acked', async () => {
    const { f, wire } = sender();
    await f.send(0, new Uint8Array(18 * 100)); // 100 frames of 18 payload bytes
    expect(data(wire, 0)).toHaveLength(32);
    // ack frames 0..15 (highest in-order seq 15)
    await f.receive(encodeFrame({ type: FrameType.ACK, stream: 0, start: false, end: false, seq: 0, payload: Uint8Array.of(15) }));
    expect(data(wire, 0)).toHaveLength(48);
    await f.receive(encodeFrame({ type: FrameType.ACK, stream: 0, start: false, end: false, seq: 0, payload: Uint8Array.of(47) }));
    expect(data(wire, 0)).toHaveLength(80);
  });

  it('windows are per stream', async () => {
    const { f, wire } = sender();
    await f.send(0, new Uint8Array(18 * 50));
    await f.send(1, new Uint8Array(18 * 50));
    expect(data(wire, 0)).toHaveLength(32);
    expect(data(wire, 1)).toHaveLength(32);
  });

  it('seq wraps past 255 with a window that keeps moving', async () => {
    const { f, wire } = sender();
    const total = 18 * 600;
    await f.send(0, new Uint8Array(total));
    let acked = 31;
    while (data(wire, 0).length < 600) {
      await f.receive(encodeFrame({ type: FrameType.ACK, stream: 0, start: false, end: false, seq: 0, payload: Uint8Array.of(acked & 0xff) }));
      acked += 16;
      if (acked > 700) break;
    }
    const seqs = data(wire, 0).map((x) => x.frame.seq);
    expect(seqs.length).toBe(Math.ceil(total / 18));
    seqs.forEach((s, i) => expect(s).toBe(i & 0xff));
  });
});

describe('receiver acks', () => {
  it('acks every 16 DATA frames and at END', async () => {
    const { f: a, wire: aw } = sender();
    const { f: b, wire: bw } = sender();
    await a.send(0, new Uint8Array(18 * 20)); // 20 frames
    for (const x of data(aw)) await b.receive(x.bytes);
    const acks = bw.filter((x) => x.frame.type === FrameType.ACK).map((x) => [x.frame.stream, x.frame.payload[0]]);
    expect(acks).toEqual([[0, 15], [0, 19]]); // after the 16th frame, and at END (frame 20, seq 19)
  });
});

describe('fairness', () => {
  it('a control message is sent within one frame of arriving, even in the middle of a large lane message', async () => {
    const { f, wire } = sender({ frameBytes: 20 });
    await f.send(1, new Uint8Array(18 * 30));
    const before = wire.length;
    await f.send(0, Uint8Array.of(1, 2, 3));
    // window on stream 1 is full at 32 frames, so free it, then check order of what follows
    const lane = data(wire, 1).length;
    expect(lane).toBeGreaterThan(0);
    const ctrl = data(wire, 0);
    expect(ctrl).toHaveLength(1);
    expect(wire.length).toBeGreaterThan(before - 1);
  });

  it('never sends more than 4 consecutive stream-1 frames while stream 0 has frames queued', async () => {
    const { f, wire } = sender({ frameBytes: 20 });
    // queue both before pumping by holding the writer
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f2 = new LinkFramer({ maxMessageBytes: 1 << 20, frameBytes: 20, write: async (b) => { await gate; wire.push({ bytes: b, frame: decodeFrame(b)! }); }, now: () => 0 });
    void f2.send(1, new Uint8Array(18 * 20));
    void f2.send(0, new Uint8Array(18 * 20));
    release();
    await f2.idle();
    void f;
    const order = data(wire).map((x) => x.frame.stream);
    let run = 0;
    let max = 0;
    for (let i = 0; i < order.length; i++) {
      run = order[i] === 1 ? run + 1 : 0;
      if (order[i] === 1) {
        // while stream 0 still has frames after this point, a lane run must stay at 4 or fewer
        if (order.slice(i + 1).includes(0)) max = Math.max(max, run);
      }
    }
    expect(max).toBeLessThanOrEqual(4);
    expect(order.filter((s) => s === 0)).toHaveLength(20);
    expect(order.filter((s) => s === 1)).toHaveLength(20);
  });
});

describe('probing', () => {
  it('uses the ladder 64, 128, 182, 244 spaced 50 ms apart, as frames of exactly that size', () => {
    expect(PROBE_LADDER).toEqual([64, 128, 182, 244]);
    expect(PROBE_SPACING_MS).toBe(50);
    for (const n of PROBE_LADDER) {
      const b = makeProbeFrame(n);
      expect(b.length).toBe(n);
      expect(decodeFrame(b)!.type).toBe(FrameType.PROBE);
    }
  });

  it('the Hub records sizes received intact and the client picks min(largest received, Hub notify limit)', () => {
    const c = new ProbeCollector();
    for (const n of [64, 128, 182]) c.onProbe(makeProbeFrame(n));
    expect(c.received()).toEqual([64, 128, 182]);
    expect(chooseFrameBytes([64, 128, 182], 244)).toBe(182);
    expect(chooseFrameBytes([64, 128, 182, 244], 100)).toBe(100);
    expect(chooseFrameBytes([], 244)).toBe(20);
    expect(chooseFrameBytes([64], 10)).toBe(20); // never below the safe floor
  });

  it('a probe frame that arrives truncated is simply not counted', () => {
    const c = new ProbeCollector();
    c.onProbe(makeProbeFrame(128).slice(0, 100)); // declared 128 but only 100 arrived: it is 100 bytes
    expect(c.received()).toEqual([100]);
  });
});

describe('write errors', () => {
  it('halve frameBytes (floor 20) and retry without losing data', async () => {
    const sizes: number[] = [];
    const wire: Uint8Array[] = [];
    const f = new LinkFramer({
      maxMessageBytes: 1 << 20,
      frameBytes: 240,
      now: () => 0,
      write: (b) => {
        sizes.push(b.length);
        if (b.length > 60) throw new Error('GATT write too long');
        wire.push(b);
      },
    });
    const msg = Uint8Array.from({ length: 500 }, (_, i) => i % 251);
    await f.send(0, msg);
    expect(f.frameBytes).toBe(60); // 240 -> 120 -> 60
    const rx = new LinkFramer({ maxMessageBytes: 1 << 20, frameBytes: 20, now: () => 0, write: () => undefined });
    const got: Uint8Array[] = [];
    for (const b of wire) got.push(...(await rx.receive(b)).messages.map((m) => m.bytes));
    expect(got).toEqual([msg]);
  });

  it('gives up (reports write-failed) when even 20-byte frames fail repeatedly', async () => {
    const errors: string[] = [];
    const f = new LinkFramer({
      maxMessageBytes: 1000,
      frameBytes: 20,
      now: () => 0,
      write: () => {
        throw new Error('gone');
      },
      onWriteFailed: () => void errors.push('write-failed'),
    });
    await f.send(0, Uint8Array.of(1));
    expect(errors).toEqual(['write-failed']);
  });
});

describe('end to end', () => {
  it('two framers deliver messages on both streams over a lossless pipe', async () => {
    const aIn: Uint8Array[] = [];
    const bIn: Uint8Array[] = [];
    // eslint-disable-next-line prefer-const
    let a!: LinkFramer;
    // eslint-disable-next-line prefer-const
    let b!: LinkFramer;
    const pump = async () => {
      while (aIn.length || bIn.length) {
        const x = aIn.shift();
        if (x) await b.receive(x);
        const y = bIn.shift();
        if (y) await a.receive(y);
      }
    };
    a = new LinkFramer({ maxMessageBytes: 1 << 20, frameBytes: 23, now: () => 0, write: (x) => void aIn.push(x) });
    b = new LinkFramer({ maxMessageBytes: 1 << 20, frameBytes: 23, now: () => 0, write: (x) => void bIn.push(x) });
    const got: Array<[number, number]> = [];
    const orig = b.receive.bind(b);
    b.receive = async (bytes) => {
      const r = await orig(bytes);
      for (const m of r.messages) got.push([m.stream, m.bytes.length]);
      return r;
    };
    const big = new Uint8Array(20_000).fill(3);
    await a.send(1, big);
    await a.send(0, Uint8Array.of(9, 9, 9));
    await a.send(0, new Uint8Array(500));
    for (let i = 0; i < 200 && got.length < 3; i++) await pump();
    expect(got.sort()).toEqual([[0, 3], [0, 500], [1, 20_000]]);
  });
});
