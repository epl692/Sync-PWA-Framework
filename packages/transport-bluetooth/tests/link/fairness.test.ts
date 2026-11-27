// Spec 005 T094/T097 (US5): lane (blob) messages ride stream 1, JSON sync messages stream 0, and a blob flood never starves packets.
import { describe, expect, it } from 'vitest';
import { FrameType, LinkChannel, LinkSession, decodeFrame, deriveSessionKeys } from '../../src/link';

/** Two ends joined by a perfect wire. Frames A writes are recorded in order. */
async function pair() {
  const keys = await deriveSessionKeys(new Uint8Array(32).fill(5), new Uint8Array(16).fill(1), new Uint8Array(16).fill(2));
  const frames: Array<{ stream: number; type: number }> = [];
  const got: Uint8Array[] = [];
  const hold = {} as { a: LinkChannel; b: LinkChannel };
  const handlers = (sink?: Uint8Array[]) => ({ control: () => undefined, core: (b: Uint8Array) => void sink?.push(b), strike: () => undefined });
  const a = (hold.a = new LinkChannel({
    maxMessageBytes: 4 << 20,
    frameBytes: 20,
    now: () => 0,
    write: (f) => {
      const d = decodeFrame(f)!;
      if (d.type === FrameType.DATA) frames.push({ stream: d.stream, type: d.type });
      void hold.b.onFrame(f.slice());
    },
    handlers: handlers(),
  }));
  const b = (hold.b = new LinkChannel({ maxMessageBytes: 4 << 20, frameBytes: 20, now: () => 0, write: (f) => void hold.a.onFrame(f.slice()), handlers: handlers(got) }));
  a.setSession(await LinkSession.create(keys.c2h, keys.h2c));
  b.setSession(await LinkSession.create(keys.h2c, keys.c2h));
  const drain = async () => {
    for (let k = 0; k < 6; k++) {
      await a.settled();
      await b.settled();
      await a.framer.idle();
      await b.framer.idle();
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  return { a, b, frames, got, drain };
}

describe('streams', () => {
  it('lane messages (first byte a lane magic) use stream 1; JSON sync messages use stream 0', async () => {
    const { a: ch, frames, drain } = await pair();
    await ch.sendCore(new TextEncoder().encode('{"t":"ping"}'));
    await drain();
    const first = frames.length;
    await ch.sendCore(Uint8Array.from([0xb1, 1, 2, 3]));
    await drain();
    expect(frames.slice(0, first).every((f) => f.stream === 0)).toBe(true);
    expect(frames.slice(first).every((f) => f.stream === 1)).toBe(true);
    expect(frames.length).toBeGreaterThan(first);
  });
});

describe('a blob flood and packet latency', () => {
  it('a packet sent in the middle of a 1 MiB blob goes out within a few frames, not after the blob', async () => {
    const { a: ch, frames, got } = await pair();
    const blob = new Uint8Array(1 << 20);
    blob[0] = 0xb1;
    void ch.sendCore(blob);
    // let the blob get well under way, then send a packet
    while (frames.filter((f) => f.stream === 1).length < 200) await new Promise((r) => setTimeout(r, 1));
    let atEnqueue = -1;
    const orig = ch.framer.enqueue.bind(ch.framer);
    ch.framer.enqueue = (stream, msg) => {
      if (stream === 0 && atEnqueue < 0) atEnqueue = frames.length; // frames sent by the time the packet is actually queued
      orig(stream, msg);
    };
    await ch.sendCore(new TextEncoder().encode('{"t":"summary","space":"S","held":{}}'));
    while (!frames.slice(Math.max(0, atEnqueue)).some((f) => f.stream === 0)) await new Promise((r) => setTimeout(r, 1));
    const firstPacketFrame = frames.findIndex((f, idx) => idx >= atEnqueue && f.stream === 0);
    // once the packet is queued, at most 4 lane frames go out before its first frame (spec: bulk delays packets by a few frames at most)
    expect(firstPacketFrame - atEnqueue).toBeLessThanOrEqual(4);
    void got;
  });

  it('under a continuous packet flood the lane still gets a turn: no more than 8 packet frames in a row while it has data', async () => {
    const { a: ch, frames, drain } = await pair();
    const blob = new Uint8Array(30_000);
    blob[0] = 0xb1;
    void ch.sendCore(blob);
    for (let i = 0; i < 30; i++) void ch.sendCore(new TextEncoder().encode(`{"t":"packets","i":${i},"pad":"${'x'.repeat(300)}"}`));
    await drain();
    const lane = frames.filter((f) => f.stream === 1).length;
    expect(lane).toBeGreaterThan(0);
    let run = 0;
    let worst = 0;
    let laneLeft = lane;
    for (const f of frames) {
      if (f.stream === 1) {
        laneLeft--;
        run = 0;
      } else {
        run += 1;
        if (laneLeft > 0) worst = Math.max(worst, run);
      }
    }
    expect(worst).toBeLessThanOrEqual(8);
  });

  it('every message of both kinds arrives intact', async () => {
    const { a: ch, got, drain } = await pair();
    const blob = Uint8Array.from({ length: 50_000 }, (_, i) => (i * 7 + 1) & 0x7f);
    blob[0] = 0xb1;
    await ch.sendCore(blob);
    for (let i = 0; i < 5; i++) await ch.sendCore(new TextEncoder().encode(`{"i":${i}}`));
    await drain();
    expect(got).toHaveLength(6);
    expect(got.find((g) => g[0] === 0xb1)).toEqual(blob);
  });
});
