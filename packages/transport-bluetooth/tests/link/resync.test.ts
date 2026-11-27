// Spec 005 US3: resync coordination and the ACK-timeout loss detector.
import { describe, expect, it } from 'vitest';
import { LinkFramer, Resync, decodeFrame, encodeFrame, FrameType, type ControlMessage } from '../../src/link';

function fakeTimers() {
  let t = 0;
  let id = 0;
  const q = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    timers: { setTimeout: (fn: () => void, ms: number) => (q.set(++id, { at: t + ms, fn }), id), clearTimeout: (h: unknown) => void q.delete(h as number) },
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const due = [...q.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        t = due[1].at;
        q.delete(due[0]);
        due[1].fn();
      }
      t = end;
    },
  };
}

function side(ft: ReturnType<typeof fakeTimers>) {
  const sent: ControlMessage[] = [];
  const log = { bounces: 0, failed: 0 };
  const r = new Resync({ send: (m) => void sent.push(m), bounce: () => void log.bounces++, failed: () => void log.failed++, timers: ft.timers, now: ft.now });
  return { r, sent, log };
}

describe('Resync', () => {
  it('on a detected loss: sends resync first, then bounces; a peer that acknowledges stops the retries', () => {
    const ft = fakeTimers();
    const a = side(ft);
    a.r.detected();
    expect(a.sent).toEqual([{ t: 'resync', id: 1 }]);
    expect(a.log.bounces).toBe(1);
    a.r.onMessage({ t: 'resync-ack', id: 1 });
    ft.advance(10_000);
    expect(a.sent).toHaveLength(1);
    expect(a.log.failed).toBe(0);
  });

  it('the receiver bounces once per id, acknowledges every copy, and never answers with a resync of its own', () => {
    const ft = fakeTimers();
    const b = side(ft);
    b.r.onMessage({ t: 'resync', id: 7 });
    b.r.onMessage({ t: 'resync', id: 7 }); // a retry
    expect(b.log.bounces).toBe(1);
    expect(b.sent).toEqual([{ t: 'resync-ack', id: 7 }, { t: 'resync-ack', id: 7 }]);
  });

  it('retries every 1.5 s and gives up after 5 unanswered tries by asking for the link to be closed', () => {
    const ft = fakeTimers();
    const a = side(ft);
    a.r.detected();
    ft.advance(1500 * 5 + 10);
    expect(a.sent.filter((m) => m.t === 'resync')).toHaveLength(5);
    expect(a.log.failed).toBe(1);
  });

  it('a second loss right after the first is folded in but still gets its own round afterwards', () => {
    const ft = fakeTimers();
    const a = side(ft);
    a.r.detected();
    a.r.onMessage({ t: 'resync-ack', id: 1 });
    ft.advance(100);
    a.r.detected(); // within the 500 ms window: not a bounce yet
    expect(a.log.bounces).toBe(1);
    ft.advance(500);
    expect(a.log.bounces).toBe(2);
    expect(a.sent.at(-1)).toEqual({ t: 'resync', id: 2 });
  });

  it('ignores junk and stops after dispose', () => {
    const ft = fakeTimers();
    const a = side(ft);
    a.r.onMessage({ t: 'resync' }); // no id
    a.r.onMessage({ t: 'resync-ack', id: 99 });
    expect(a.log.bounces).toBe(0);
    a.r.detected();
    a.r.dispose();
    ft.advance(10_000);
    expect(a.sent).toHaveLength(1);
  });
});

describe('ACK timeout detector', () => {
  it('frames never acknowledged are reported as stalled after the timeout, and forgetting them frees the window', async () => {
    let t = 0;
    const wire: Uint8Array[] = [];
    const f = new LinkFramer({ maxMessageBytes: 1 << 20, frameBytes: 20, now: () => t, write: (b) => void wire.push(b) });
    await f.send(0, new Uint8Array(18 * 40)); // 40 frames, window 32
    expect(wire).toHaveLength(32);
    expect(f.stalled(2_999, 3_000)).toBe(false);
    t = 3_000;
    expect(f.stalled(t, 3_000)).toBe(true);
    f.forgetUnacked();
    await f.idle();
    expect(wire.filter((w) => decodeFrame(w)!.type === FrameType.DATA)).toHaveLength(40); // the rest went out
  });

  it('an ACK that makes progress resets the timer', async () => {
    let t = 0;
    const f = new LinkFramer({ maxMessageBytes: 1 << 20, frameBytes: 20, now: () => t, write: () => undefined });
    await f.send(0, new Uint8Array(18 * 40));
    t = 2_000;
    await f.receive(encodeFrame({ type: FrameType.ACK, stream: 0, start: false, end: false, seq: 0, payload: Uint8Array.of(15) }));
    expect(f.stalled(4_000, 3_000)).toBe(false); // progress at t = 2 s
    expect(f.stalled(5_000, 3_000)).toBe(true);
  });

  it('nothing in flight is never stalled', () => {
    const f = new LinkFramer({ maxMessageBytes: 1000, now: () => 0, write: () => undefined });
    expect(f.stalled(1e9, 3_000)).toBe(false);
  });
});
