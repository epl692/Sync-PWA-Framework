// T067: a removal records, per device, the highest sequence number the remover holds.
import { describe, expect, it } from 'vitest';
import { waitFor } from '@sync/testkit';
import { buildFamily } from '../family';

describe('removal cutoff', () => {
  it('equals the highest sequence number of each of the member’s devices that the Owner holds', async () => {
    const f = await buildFamily();
    for (let i = 0; i < 3; i++) await f.editor.core.create(f.space.id, 'note', { i });
    await waitFor(async () => (await f.owner.core.query({ type: 'note' }).once()).length === 3, 8000, 'owner holds the editor packets');
    const held = await f.owner.core.held(f.space.id);
    const device = f.editor.core.deviceId;
    const top = held[device]!.reduce((m, [, hi]) => Math.max(m, hi), 0);
    expect(top).toBe(3);
    await f.owner.spaces.remove(f.space.id, f.editor.spaces.session()!.user);
    const ev = (await f.owner.core.scanApplied(f.space.id, { typePrefix: '$sys.member' })).find((x) => (x.body.fields as { action?: string }).action === 'remove')!;
    expect((ev.body.fields as { cutoff: Record<string, number> }).cutoff).toEqual({ [device]: 3 });
    await f.g.close();
  });

  it('is 0 for a device the Owner never heard from, so none of its packets are accepted later', async () => {
    const f = await buildFamily();
    await f.owner.spaces.remove(f.space.id, f.viewer.spaces.session()!.user);
    const ev = (await f.owner.core.scanApplied(f.space.id, { typePrefix: '$sys.member' })).find((x) => (x.body.fields as { action?: string }).action === 'remove')!;
    expect((ev.body.fields as { cutoff: Record<string, number> }).cutoff).toEqual({ [f.viewer.core.deviceId]: 0 });
    await f.g.close();
  });
});
