// T010 (C-1): registering type behavior in any order, at any time, never changes converged state.
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { createTestCore, remoteEnvelope } from '@sync/testkit';

const RUNS = Number(process.env.CONVERGENCE_RUNS ?? 200);

describe('C-1 registerType order independence', () => {
  it('equal stateHash whatever the registration order and timing', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('create', 'edit', 'del'), { minLength: 3, maxLength: 8 }),
        fc.integer({ min: 0, max: 8 }),
        fc.boolean(),
        async (ops, registerAfter, shuffle) => {
          const packets = await Promise.all(
            ops.map((op, i) =>
              remoteEnvelope(
                { obj: 'o1', op: op === 'create' ? 'create' : op === 'edit' ? 'update' : 'delete', type: 'm.doc', fields: op === 'del' ? {} : { v: String(i) } },
                { author: `DEVICE${i % 3}`, seq: i + 1, wall: 100 + i * 50 },
              ),
            ),
          );
          const a = await createTestCore();
          const b = await createTestCore({ resurrectingTypes: ['m.doc'] });
          const order = packets.map((_, i) => i);
          if (shuffle) order.reverse();
          for (const [n, i] of order.entries()) {
            if (n === registerAfter) a.core.registerType('m.doc', { resurrects: true });
            await a.core.ingest(packets[i]!.raw, 'p');
          }
          a.core.registerType('m.doc', { resurrects: true });
          for (const i of order.slice().reverse()) await b.core.ingest(packets[i]!.raw, 'p');
          expect(await a.core.stateHash('s1')).toBe(await b.core.stateHash('s1'));
          expect(!!(await a.core.get('o1'))).toBe(!!(await b.core.get('o1')));
        },
      ),
      { numRuns: RUNS },
    );
  });
});
