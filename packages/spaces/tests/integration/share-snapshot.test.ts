// T078: share-bound packets are never folded into snapshots, so snapshots hold only Space-scoped state.
import { describe, expect, it } from 'vitest';
import { readPacketRecords, waitFor } from '@sync/testkit';
import { buildFamily } from '../family';

const DAY = 24 * 60 * 60 * 1000;

describe('shares and compaction', () => {
  it('keeps a share’s packets (and all control events) out of snapshots; ordinary objects are still compacted', async () => {
    const f = await buildFamily();
    const plain = await f.editor.core.create(f.space.id, 'note', { text: 'ordinary' });
    const { object } = await f.editor.spaces.createInShare(f.space.id, 'gift', { idea: 'private' }, [{ user: f.owner.spaces.session()!.user, role: 'editor' }]);
    await f.editor.core.update(object.id, { idea: 'private v2' });
    await waitFor(async () => (await f.owner.core.get(object.id)) !== undefined, 12_000, 'owner in the share reads it');
    f.g.clock.advance(40 * DAY);

    const r = await f.editor.core.compact();
    expect(r.packetsRemoved).toBeGreaterThan(0);
    const snap = (await f.editor.core.exportSnapshot(f.space.id))!;
    expect(snap.objects.map((o) => o.id)).toEqual([plain.id]);
    const left = await readPacketRecords(f.editor.storage);
    expect(left.some((p) => p.obj === object.id)).toBe(true);
    expect(left.filter((p) => p.type?.startsWith('$sys.')).length).toBeGreaterThanOrEqual(8);
    expect((await f.editor.core.get(object.id))!.fields.idea).toBe('private v2');
    expect((await f.editor.core.get(plain.id))!.fields.text).toBe('ordinary');
    await f.g.close();
  });
});
