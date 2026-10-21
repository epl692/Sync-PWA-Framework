// T031: quota problems surface as typed errors, lose no data, and raise a pressure event.
import { describe, expect, it } from 'vitest';
import { StorageQuotaError, createMemoryStorage } from '@sync/core';
import { createTestCore, remoteEnvelope } from '@sync/testkit';

describe('storage quota', () => {
  it('fails a local write with StorageQuotaError, keeps existing data, and emits storage:pressure', async () => {
    const t = await createTestCore({ storage: createMemoryStorage({ quotaBytes: 20_000 }) });
    const ok = await t.core.create('s1', 'note', { t: 'small' });
    const events: string[] = [];
    t.core.on((e) => events.push(e.kind));

    await expect(t.core.create('s1', 'note', { t: 'x'.repeat(50_000) })).rejects.toBeInstanceOf(StorageQuotaError);
    expect(events).toContain('storage:pressure');
    expect(await t.core.query({ type: 'note' }).once()).toHaveLength(1);
    expect((await t.core.get(ok.id))!.fields.t).toBe('small');

    // the core keeps working for writes that fit
    await t.core.update(ok.id, { t: 'still fine' });
    expect((await t.core.get(ok.id))!.fields.t).toBe('still fine');
  });

  it('does not mark an inbound packet as held when it could not be stored', async () => {
    const t = await createTestCore({ storage: createMemoryStorage({ quotaBytes: 6_000 }) });
    const big = await remoteEnvelope({ obj: 'o1', op: 'create', type: 't', fields: { blob: 'x'.repeat(30_000) } }, { seq: 1 });
    const r = await t.core.ingest(big.raw, 'peer');
    expect(r).toMatchObject({ status: 'rejected', reason: 'storage-quota' });
    expect(await t.core.get('o1')).toBeUndefined();
  });

  it('asks the platform for persistent storage when the core opens', async () => {
    let asked = 0;
    const base = createMemoryStorage();
    const storage = { ...base, transaction: base.transaction.bind(base), close: base.close.bind(base), persist: async () => (asked++, true) };
    await createTestCore({ storage });
    expect(asked).toBe(1);
  });
});
