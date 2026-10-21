// T011a: inbound limits (FR-021). Each violation rejects only that packet.
import { describe, expect, it } from 'vitest';
import { PlaintextCodec, createTestCore, remoteEnvelope } from '@sync/testkit';

describe('inbound limits (FR-021)', () => {
  it('rejects an envelope larger than maxEnvelopeBytes and keeps going', async () => {
    const t = await createTestCore({ limits: { maxEnvelopeBytes: 600 } });
    const big = await remoteEnvelope({ obj: 'o1', op: 'create', type: 't', fields: { blob: 'x'.repeat(2000) } }, { seq: 1 });
    const ok = await remoteEnvelope({ obj: 'o2', op: 'create', type: 't', fields: { a: 1 } }, { seq: 2 });
    const r1 = await t.core.ingest(big.raw, 'peer');
    const r2 = await t.core.ingest(ok.raw, 'peer');
    expect(r1.status).toBe('rejected');
    expect(r2.status).toBe('applied');
    expect(await t.core.get('o1')).toBeUndefined();
    expect(await t.core.get('o2')).toBeDefined();
  });

  it('rejects a packet with more than maxFieldsPerPacket fields', async () => {
    const t = await createTestCore({ limits: { maxFieldsPerPacket: 3 } });
    const fields = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`f${i}`, i]));
    const env = await remoteEnvelope({ obj: 'o1', op: 'create', type: 't', fields }, { seq: 1 });
    expect((await t.core.ingest(env.raw, 'peer')).status).toBe('rejected');
  });

  it('rejects a delete that carries fields', async () => {
    const t = await createTestCore();
    const env = await remoteEnvelope({ obj: 'o1', op: 'delete', type: 't', fields: { sneaky: 1 } }, { seq: 1 });
    expect((await t.core.ingest(env.raw, 'peer')).status).toBe('rejected');
  });

  it('accepts a large seq jump but emits a warning event', async () => {
    const t = await createTestCore({ limits: { seqGapWarn: 100 } });
    const events: string[] = [];
    t.core.on((e) => events.push(e.kind));
    const first = await remoteEnvelope({ obj: 'o1', op: 'create', type: 't', fields: { a: 1 } }, { seq: 1 });
    const jump = await remoteEnvelope({ obj: 'o1', op: 'update', type: 't', fields: { a: 2 } }, { seq: 5000 });
    await t.core.ingest(first.raw, 'peer');
    expect((await t.core.ingest(jump.raw, 'peer')).status).toBe('applied');
    expect(events).toContain('sync:progress');
  });

  it('uses the plaintext codec only through the test kit', () => {
    expect(new PlaintextCodec().id).toBe('test-plaintext/1');
  });
});
