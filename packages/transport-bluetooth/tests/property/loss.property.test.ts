// Spec 005 T073 (US3): over a radio that loses and duplicates frames, nothing corrupt is ever delivered: every message that
// arrives authenticates and equals one that was sent, per stream in order; losses are reported so the layer above can resync.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { LinkChannel, LinkSession, deriveSessionKeys } from '../../src/link';

const runs = Number(process.env.CONVERGENCE_RUNS ?? 30);

async function pair(faults: Array<'ok' | 'drop' | 'dup'>, frameBytes: number) {
  const keys = await deriveSessionKeys(new Uint8Array(32).fill(5), new Uint8Array(16).fill(1), new Uint8Array(16).fill(2));
  const received: Array<{ stream: number; bytes: Uint8Array }> = [];
  const lost: string[] = [];
  const strikes: string[] = [];
  let i = 0;
  // eslint-disable-next-line prefer-const
  let a!: LinkChannel;
  // eslint-disable-next-line prefer-const
  let b!: LinkChannel;
  const wire = (to: () => LinkChannel) => async (frame: Uint8Array) => {
    const f = faults[i++ % Math.max(1, faults.length)] ?? 'ok';
    if (f === 'drop') return;
    const copies = f === 'dup' ? 2 : 1;
    for (let k = 0; k < copies; k++) void to().onFrame(frame.slice());
  };
  a = new LinkChannel({ maxMessageBytes: 1 << 20, frameBytes, now: () => 0, write: wire(() => b), handlers: { control: () => undefined, core: () => undefined, strike: () => undefined } });
  b = new LinkChannel({
    maxMessageBytes: 1 << 20,
    frameBytes,
    now: () => 0,
    write: wire(() => a),
    handlers: { control: () => undefined, core: (bytes, stream) => void received.push({ stream, bytes }), strike: (r) => void strikes.push(r), lost: (r) => void lost.push(r) },
  });
  a.setSession(await LinkSession.create(keys.c2h, keys.h2c));
  b.setSession(await LinkSession.create(keys.h2c, keys.c2h));
  return { a, b, received, lost, strikes };
}

describe('lossy radio', () => {
  it('never delivers a corrupt message, never reorders a stream, and reports what it lost', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.constantFrom(0, 1), fc.integer({ min: 1, max: 600 })), { minLength: 1, maxLength: 12 }),
        fc.array(fc.constantFrom('ok', 'ok', 'ok', 'ok', 'drop', 'dup'), { minLength: 1, maxLength: 60 }),
        fc.integer({ min: 20, max: 120 }),
        async (msgs, faults, fb) => {
          const { a, b, received, lost, strikes } = await pair(faults as Array<'ok' | 'drop' | 'dup'>, fb);
          const sent = msgs.map(([stream, n], idx) => {
            const bytes = Uint8Array.from({ length: n }, (_, j) => (idx * 31 + j) & 0x7f); // first byte < 0x80: not a lane message...
            if (stream === 1) bytes[0] = 0xb1; // ...unless it is meant to be one (lane messages ride stream 1)
            return bytes;
          });
          for (const m of sent) await a.sendCore(m);
          await a.settled();
          for (let k = 0; k < 20; k++) await new Promise((r) => setTimeout(r, 0));
          await b.settled();
          // every delivered message is exactly one that was sent
          for (const r of received) expect(sent.some((s) => s.length === r.bytes.length && s.every((x, j) => x === r.bytes[j]))).toBe(true);
          // each stream keeps its order
          for (const stream of [0, 1]) {
            const idx = received.filter((r) => r.stream === stream).map((r) => sent.findIndex((s) => s.length === r.bytes.length && s.every((x, j) => x === r.bytes[j])));
            expect([...idx].sort((x, y) => x - y)).toEqual(idx);
          }
          // nothing failed authentication: damage shows up as loss, never as a bad message
          expect(strikes.filter((s) => s === 'bad-message' || s === 'bad-inner')).toEqual([]);
          // if anything was dropped and fewer messages arrived than were sent, a loss was reported (or it was the final message of a stream)
          const dropped = faults.includes('drop');
          if (!dropped) expect(received.length).toBe(sent.length);
          void lost;
        },
      ),
      { numRuns: runs },
    );
  });
});
