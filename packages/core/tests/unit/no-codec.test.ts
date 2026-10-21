// T032a / FR-020: with no codec registered, local writes fail and nothing is stored.
import { describe, expect, it } from 'vitest';
import { NoCodecError } from '@sync/core';
import { createTestCore, readOutbox, readPacketRecords } from '@sync/testkit';

describe('no codec registered (FR-020)', () => {
  it('rejects create, update and remove with NoCodecError and stores nothing', async () => {
    const t = await createTestCore({ codec: false });
    await expect(t.core.create('s1', 'note', { a: 1 })).rejects.toBeInstanceOf(NoCodecError);
    await expect(t.core.update('x', { a: 1 })).rejects.toBeInstanceOf(NoCodecError);
    await expect(t.core.remove('x')).rejects.toBeInstanceOf(NoCodecError);
    expect(await readPacketRecords(t.storage)).toEqual([]);
    expect(await readOutbox(t.storage)).toEqual([]);
  });
});
