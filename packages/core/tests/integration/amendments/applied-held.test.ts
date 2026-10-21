// A-8: onApplied observer and held() summary.
import { describe, expect, it } from 'vitest';
import { createTestCore, remoteEnvelope } from '@sync/testkit';

describe('A-8 onApplied and held', () => {
  it('fires for local writes, remote ingests and parked packets applied later, but not for duplicates', async () => {
    const t = await createTestCore();
    let defer = true;
    t.core.registerValidator({ id: 'd', phases: ['apply'], validate: (_p, env) => (env.author === 'LATERAAAAAAAAAAAAAAAAAAA' && defer ? { verdict: 'defer', reason: 'x' } : { verdict: 'accept' }) });
    const seen: string[] = [];
    t.core.onApplied((e) => seen.push(`${e.source}:${e.body.obj}`));
    await t.core.create('s1', 'item', { a: 1 }, { id: 'local1' });
    const r = await remoteEnvelope({ obj: 'r1', op: 'create', type: 'item', fields: {} }, { author: 'REMOTEAAAAAAAAAAAAAAAAAAA', seq: 1 });
    await t.core.ingest(r.raw, 'peer');
    await t.core.ingest(r.raw, 'peer'); // duplicate
    const later = await remoteEnvelope({ obj: 'r2', op: 'create', type: 'item', fields: {} }, { author: 'LATERAAAAAAAAAAAAAAAAAAA', seq: 1 });
    await t.core.ingest(later.raw, 'peer');
    expect(seen).toEqual(['local:local1', 'peer:r1']);
    defer = false;
    await t.core.revalidate();
    expect(seen).toEqual(['local:local1', 'peer:r1', 'peer:r2']);
  });

  it('reports held intervals per author', async () => {
    const t = await createTestCore();
    await t.core.create('s1', 'item', {});
    await t.core.create('s1', 'item', {});
    expect(await t.core.held('s1')).toEqual({ [t.core.deviceId]: [[1, 2]] });
  });
});
