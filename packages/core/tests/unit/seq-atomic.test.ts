// T030: a packet, its seq, the summary and the outbox entry commit together or not at all.
import { describe, expect, it } from 'vitest';
import { createMemoryStorage, type StorageAdapter, type StorageTx, type StoreName } from '@sync/core';
import { createTestCore, readOutbox, readPacketRecords } from '@sync/testkit';

function failingOnOutbox(inner: StorageAdapter, armed: { on: boolean }): StorageAdapter {
  return {
    ...inner,
    transaction: (stores, mode, fn) =>
      inner.transaction(stores, mode, (tx: StorageTx) =>
        fn({
          ...tx,
          get: tx.get.bind(tx),
          delete: tx.delete.bind(tx),
          scan: tx.scan.bind(tx),
          put: async (s: StoreName, k: string, v: unknown) => {
            if (armed.on && s === 'outbox') throw new Error('simulated crash');
            return tx.put(s, k, v);
          },
        }),
      ),
    close: () => inner.close(),
  } as StorageAdapter;
}

describe('seq and packet are persisted atomically', () => {
  it('leaves no orphan packet and no seq gap after a failed write', async () => {
    const inner = createMemoryStorage();
    const armed = { on: false };
    const t = await createTestCore({ storage: failingOnOutbox(inner, armed) });
    const o = await t.core.create('s1', 'note', { a: 1 });

    armed.on = true;
    await expect(t.core.update(o.id, { a: 2 })).rejects.toThrow('simulated crash');
    armed.on = false;

    expect((await t.core.get(o.id))!.fields.a).toBe(1); // in-memory state matches storage
    expect(await readPacketRecords(inner)).toHaveLength(1);
    expect(await readOutbox(inner)).toHaveLength(1);

    await t.core.update(o.id, { a: 3 });
    const seqs = (await readPacketRecords(inner)).map((p) => p.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2]);

    const again = await t.reopen();
    expect((await again.get(o.id))!.fields.a).toBe(3);
  });
});
