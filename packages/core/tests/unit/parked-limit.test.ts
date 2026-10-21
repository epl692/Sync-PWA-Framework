// T011 (A-7): parked packets per author are bounded; the excess is neither stored nor counted as held.
import { describe, expect, it } from 'vitest';
import { decodeEnvelope, type CoreEvent } from '@sync/core';
import { createTestCore, readPacketRecords, remoteEnvelope } from '@sync/testkit';

const A = 'PARKEDAAAAAAAAAAAAAAAAAAA';

async function core(limit: number) {
  let defer = true;
  const t = await createTestCore({ limits: { maxParkedPerAuthor: limit } });
  t.core.registerValidator({ id: 'defer', phases: ['apply'], validate: () => (defer ? { verdict: 'defer', reason: 'later' } : { verdict: 'accept' }) });
  return { t, release: () => (defer = false) };
}

describe('A-7 parked limit', () => {
  it('stops storing parked packets from one author past the limit and reports them', async () => {
    const { t } = await core(3);
    const events: CoreEvent[] = [];
    t.core.on((e) => events.push(e));
    const results = [];
    for (let seq = 1; seq <= 5; seq++) {
      const e = await remoteEnvelope({ obj: `o${seq}`, op: 'create', type: 'item', fields: {} }, { author: A, seq });
      results.push((await t.core.ingest(e.raw, 'test')).status);
    }
    expect(results).toEqual(['parked', 'parked', 'parked', 'rejected', 'rejected']);
    expect(await readPacketRecords(t.storage)).toHaveLength(3);
    expect(events.filter((e) => e.kind === 'packet:rejected' && /parked-limit/.test(e.reason))).toHaveLength(2);
  });

  it('accepts the excess later, once the author is no longer deferred', async () => {
    const { t, release } = await core(2);
    const raws = [];
    for (let seq = 1; seq <= 4; seq++) raws.push((await remoteEnvelope({ obj: `o${seq}`, op: 'create', type: 'item', fields: {} }, { author: A, seq })).raw);
    for (const r of raws) await t.core.ingest(r, 'test');
    release();
    expect((await t.core.revalidate()).applied).toBe(2);
    for (const r of raws.slice(2)) expect((await t.core.ingest(r, 'test')).status).toBe('applied');
    expect((await readPacketRecords(t.storage)).every((p) => p.status === 'applied')).toBe(true);
    expect(decodeEnvelope(raws[0]!).env.author).toBe(A);
  });

  it('counts per author', async () => {
    const { t } = await core(1);
    const a = await remoteEnvelope({ obj: 'a', op: 'create', type: 'item', fields: {} }, { author: A, seq: 1 });
    const b = await remoteEnvelope({ obj: 'b', op: 'create', type: 'item', fields: {} }, { author: 'OTHERAAAAAAAAAAAAAAAAAAA', seq: 1 });
    expect((await t.core.ingest(a.raw, 't')).status).toBe('parked');
    expect((await t.core.ingest(b.raw, 't')).status).toBe('parked');
  });
});
