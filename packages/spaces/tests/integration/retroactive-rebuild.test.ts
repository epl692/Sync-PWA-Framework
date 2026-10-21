// T050: a removal that arrives after the removed member's late packets were applied makes every peer converge again.
import { describe, expect, it } from 'vitest';
import { waitFor } from '@sync/testkit';
import type { SecurityEvent } from '../../src';
import { buildFamily, settle } from '../family';

describe('retroactive authority changes (research R-10)', () => {
  it('a peer that applied a removed member’s late packets rebuilds when the removal arrives', async () => {
    const f = await buildFamily();
    f.g.link('editor', 'viewer');
    const early = await f.editor.core.create(f.space.id, 'note', { n: 'before removal' });
    await waitFor(
      async () =>
        (await f.viewer.core.get(early.id)) !== undefined && (await f.owner.core.get(early.id)) !== undefined,
      8000,
      'early note everywhere',
    );

    // the Viewer and the Editor lose touch with the Owner
    f.g.net.sever('owner', 'viewer');
    f.g.net.sever('owner', 'editor');
    f.g.net.sever('owner', 'obs');
    const events: SecurityEvent[] = [];
    f.viewer.spaces.on((e) => events.push(e));
    await f.owner.spaces.remove(f.space.id, f.editor.spaces.session()!.user);

    // the Editor does not know, and writes on; the Viewer takes those writes at face value
    const late = [];
    for (let i = 0; i < 3; i++) late.push(await f.editor.core.create(f.space.id, 'note', { n: `late ${i}` }));
    await waitFor(
      async () => (await f.viewer.core.query({ type: 'note' }).once()).length === 4,
      8000,
      'viewer applies the late notes',
    );

    // contact is restored: the removal reaches the Viewer
    f.g.net.restore('owner', 'viewer');
    f.g.net.restore('owner', 'obs');
    await waitFor(async () => events.some((e) => e.kind === 'space:rebuilt'), 10_000, 'viewer rebuilds');
    await settle(f.g);
    expect((await f.viewer.core.query({ type: 'note' }).once()).map((o) => o.fields.n)).toEqual([
      'before removal',
    ]);
    const rebuilt = events.find(
      (e): e is Extract<SecurityEvent, { kind: 'space:rebuilt' }> => e.kind === 'space:rebuilt',
    )!;
    expect(rebuilt.rejected).toBeGreaterThanOrEqual(3);
    expect(await f.viewer.spaces.rejectedCount(f.space.id)).toBeGreaterThanOrEqual(3);

    // everyone who still has contact agrees
    await waitFor(
      async () => (await f.owner.core.stateHash(f.space.id)) === (await f.viewer.core.stateHash(f.space.id)),
      10_000,
      'owner and viewer converge',
    );
    expect((await f.owner.core.query({ type: 'note' }).once()).map((o) => o.fields.n)).toEqual([
      'before removal',
    ]);
    expect((await f.obs.core.query({ type: 'note' }).once()).map((o) => o.fields.n)).toEqual([
      'before removal',
    ]);
    void late;
    await f.g.close();
  });
});
