// T059 / SC-004: randomized convergence. Replay a failure with CONVERGENCE_SEED=<seed>.
// Quick by default (500 runs); the release gate sets CONVERGENCE_RUNS=10000.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalString, formatClock, mergeInto, type PacketBody, type StoredObject } from '@sync/core';
import { runScenario, scenarioArb } from '@sync/testkit';

const runs = Number(process.env.CONVERGENCE_RUNS ?? 500);
const seed = process.env.CONVERGENCE_SEED ? Number(process.env.CONVERGENCE_SEED) : undefined;

describe('convergence (SC-004)', () => {
  it(
    `${runs} random partition scenarios end with identical state hashes on every peer`,
    async () => {
      await fc.assert(
        fc.asyncProperty(scenarioArb, async (sc) => {
          const { hashes, rehashed } = await runScenario(sc);
          expect(new Set(hashes).size, `hashes differ: ${JSON.stringify(hashes)}`).toBe(1);
          expect(rehashed).toEqual(hashes); // re-delivery changes nothing (idempotent)
        }),
        { numRuns: runs, seed, verbose: 1 },
      );
    },
    30 * 60_000,
  );

  it('the merge function itself is commutative, associative and idempotent', () => {
    const packetArb = fc.record({
      wall: fc.integer({ min: 1, max: 50 }),
      counter: fc.integer({ min: 0, max: 3 }),
      device: fc.constantFrom('DEVA', 'DEVB', 'DEVC'),
      op: fc.constantFrom('create', 'update', 'update', 'delete') as fc.Arbitrary<PacketBody['op']>,
      type: fc.constantFrom('x', 'y'),
      fields: fc.dictionary(fc.constantFrom('a', 'b', 'c'), fc.oneof(fc.integer({ min: 0, max: 5 }), fc.constant({ $unset: true })), { maxKeys: 3 }),
    });
    const apply = (packets: { wall: number; counter: number; device: string; op: PacketBody['op']; type: string; fields: Record<string, unknown> }[]) => {
      let obj: StoredObject | undefined;
      for (const p of packets) {
        const body: PacketBody = { obj: 'o', op: p.op, type: p.type, schemaVersion: 1, fields: p.op === 'delete' ? {} : (p.fields as PacketBody['fields']) };
        obj = mergeInto(obj, body, { clock: formatClock(p.wall, p.counter, p.device), space: 's' }).obj;
      }
      return canonicalString(obj);
    };
    fc.assert(
      fc.property(
        fc.array(packetArb, { minLength: 1, maxLength: 12 }).map((ps) => {
          // identical (clock) means identical packet, so keep one per clock
          const seen = new Set<string>();
          return ps.filter((p) => !seen.has(`${p.wall}-${p.counter}-${p.device}`) && !!seen.add(`${p.wall}-${p.counter}-${p.device}`));
        }),
        fc.integer(),
        (packets, s) => {
          const rnd = (() => {
            let a = s >>> 0;
            return () => ((a = (Math.imul(a ^ (a >>> 15), 2246822507) + 1) >>> 0) / 4294967296);
          })();
          const shuffled = packets.slice().sort(() => rnd() - 0.5);
          expect(apply(shuffled)).toBe(apply(packets));
          expect(apply([...packets, ...packets])).toBe(apply(packets)); // idempotent
        },
      ),
      { numRuns: runs * 4, seed },
    );
  });
});
