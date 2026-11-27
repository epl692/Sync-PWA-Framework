import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Reassembler, decodeFrame, encodeFrame, splitMessage } from '../../src/link/frames';

const runs = Number(process.env.CONVERGENCE_RUNS ?? 60);

describe('frame properties', () => {
  it('any message split at any frameBytes in 20..244 reassembles to the original', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 3000 }), fc.integer({ min: 20, max: 244 }), fc.integer({ min: 0, max: 255 }), fc.constantFrom(0, 1), (msg, fb, seq0, stream) => {
        const r = new Reassembler({ maxMessageBytes: 4000 });
        let out: Uint8Array | undefined;
        for (const f of splitMessage(msg, fb, stream as 0 | 1, seq0)) {
          const wire = encodeFrame(f);
          expect(wire.length).toBeLessThanOrEqual(fb);
          out = r.push(decodeFrame(wire)!, 0).message ?? out;
        }
        expect(out).toEqual(msg);
      }),
      { numRuns: runs },
    );
  });

  it('dropped or duplicated frames never deliver a corrupted message', () => {
    fc.assert(
      fc.property(
        fc.array(fc.uint8Array({ minLength: 1, maxLength: 400 }), { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 20, max: 64 }),
        fc.array(fc.constantFrom('ok', 'drop', 'dup'), { minLength: 0, maxLength: 80 }),
        (msgs, fb, faults) => {
          const r = new Reassembler({ maxMessageBytes: 4000 });
          const delivered: Uint8Array[] = [];
          let seq = 0;
          let i = 0;
          for (const m of msgs) {
            const frames = splitMessage(m, fb, 0, seq);
            seq = (seq + frames.length) % 256;
            for (const f of frames) {
              const fault = faults[i++] ?? 'ok';
              if (fault === 'drop') continue;
              const n = fault === 'dup' ? 2 : 1;
              for (let k = 0; k < n; k++) {
                const res = r.push(f, 0);
                if (res.message) delivered.push(res.message);
              }
            }
          }
          // anything delivered is exactly one of the original messages (never a mix)
          for (const d of delivered) expect(msgs.some((m) => m.length === d.length && m.every((b, j) => b === d[j]))).toBe(true);
        },
      ),
      { numRuns: runs },
    );
  });
});
