// T065: an object's type and Space follow the lowest-clock packet; schemaVersion follows the highest.
import { describe, expect, it } from 'vitest';
import { createTestCore, remoteEnvelope } from '@sync/testkit';

describe('object identity under conflicting packets', () => {
  it('takes type from the lowest-clock packet in any arrival order', async () => {
    const early = await remoteEnvelope({ obj: 'o1', op: 'create', type: 'first', fields: { a: 1 } }, { author: 'EARLYDEVICE', seq: 1, wall: 100 });
    const late = await remoteEnvelope({ obj: 'o1', op: 'create', type: 'second', fields: { b: 2 } }, { author: 'LATEDEVICE', seq: 1, wall: 200 });
    for (const order of [[early, late], [late, early]]) {
      const t = await createTestCore();
      for (const e of order) await t.core.ingest(e.raw, 'p');
      expect(await t.core.get('o1')).toMatchObject({ type: 'first', fields: { a: 1, b: 2 } });
      expect(await t.core.query({ type: 'first' }).once()).toHaveLength(1);
      expect(await t.core.query({ type: 'second' }).once()).toHaveLength(0);
    }
  });

  it('keeps the highest schemaVersion seen', async () => {
    const t = await createTestCore();
    const v1 = await remoteEnvelope({ obj: 'o1', op: 'create', type: 't', schemaVersion: 1, fields: {} }, { author: 'DEVICEONE', seq: 1, wall: 100 });
    const v3 = await remoteEnvelope({ obj: 'o1', op: 'update', type: 't', schemaVersion: 3, fields: {} }, { author: 'DEVICETWO', seq: 1, wall: 50 });
    await t.core.ingest(v3.raw, 'p');
    await t.core.ingest(v1.raw, 'p');
    expect((await t.core.get('o1'))!.schemaVersion).toBe(3);
  });
});
